'use strict';

// The detail CLI 1.7.0 adds to run.reach (projectLoadFailures,
// workspaceLoadFailures, unevaluableRules, ruleFaults) tells which rule or
// project made a run inconclusive and why; reachDetail renders it for the PR
// comment and the step message, and renders any array a later CLI adds
// generically. The entry shapes follow the CLI's RunProjectLoadFailureInfo,
// RunReachUnevaluableRuleInfo and RunRuleFaultInfo records.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as action from '../src/index.js';

const { reachDetail, reachFromReport, buildComment, tally, configErrorsFromLog } = action;

const ruleFault = (overrides = {}) => ({
  ruleId: 'god-class',
  kind: 'item-skipped',
  count: 3,
  exceptionTypes: ['System.NullReferenceException'],
  message: 'Object reference not set to an instance of an object.',
  expression: { line: 4, column: 12 },
  elements: [
    { kind: 'Class', name: 'Calc', namespace: 'Lib', filePath: '/home/runner/work/app/app/src/Lib/Calc.cs', line: 3 },
  ],
  ...overrides,
});

test('reachDetail_WhenAProjectFailedToLoad_NamesTheProjectAndCause', () => {
  const lines = reachDetail({ projectLoadFailures: [{ project: 'src/Lib/Lib.csproj', cause: 'restore missing' }] });
  assert.deepEqual(lines, ['Project src/Lib/Lib.csproj did not load: restore missing']);
});

test('reachDetail_WhenEntriesLackFields_SaysWhatIsUnknown', () => {
  assert.deepEqual(reachDetail({ projectLoadFailures: [{}], unevaluableRules: [null] }), [
    'Project unknown did not load: no cause given',
    'Rule unknown could not be evaluated: no reason given',
  ]);
});

test('reachDetail_WhenTheWorkspaceReportedFailures_ListsEach', () => {
  assert.deepEqual(reachDetail({ workspaceLoadFailures: ['SDK not found'] }), [
    'Workspace load failure: SDK not found',
  ]);
});

test('reachDetail_WhenARuleCouldNotBeEvaluated_NamesTheRuleAndReason', () => {
  assert.deepEqual(reachDetail({ unevaluableRules: [{ ruleId: 'x-rule', reason: 'unknown fact m.Foo' }] }), [
    'Rule x-rule could not be evaluated: unknown fact m.Foo',
  ]);
});

test('reachDetail_WhenARuleFaulted_SaysWhatThrewWhereAndOnWhat', () => {
  assert.deepEqual(reachDetail({ ruleFaults: [ruleFault()] }), [
    'Rule god-class threw on some elements and skipped them 3 times (System.NullReferenceException) at rule line 4:12 ' +
      'on class Lib.Calc (Calc.cs:3): Object reference not set to an instance of an object.',
  ]);
});

test('reachDetail_WhenAFaultHasOtherKindsAndFewFields_StillDescribesIt', () => {
  const lines = reachDetail({
    ruleFaults: [
      ruleFault({ kind: 'rule-aborted', count: 1, exceptionTypes: [], expression: null, elements: [], message: '' }),
      ruleFault({
        kind: 'engine-defect',
        expression: { line: 2 },
        elements: [
          { kind: 'Method', name: 'Add' },
          { name: 'B', filePath: 'C:\\r\\B.cs' },
          {},
          { name: 'D' },
          { name: 'E' },
        ],
      }),
      ruleFault({
        kind: 'brand-new',
        ruleId: '',
        elements: undefined,
        message: 'm',
        exceptionTypes: undefined,
        expression: { column: 1 },
      }),
      ruleFault({ kind: undefined, elements: [null] }),
      'not an object',
    ],
  });
  assert.equal(lines[0], 'Rule god-class threw and reported nothing');
  assert.match(
    lines[1],
    /^Rule god-class hit an engine defect and reported nothing 3 times .* at rule line 2 on method Add, B \(B\.cs\), D and 1 more:/
  );
  assert.equal(lines[2], 'Rule unknown faulted (brand-new) 3 times: m');
  assert.match(lines[3], /^Rule god-class faulted \(unknown kind\) 3 times/);
  assert.equal(lines.length, 4);
});

test('reachDetail_WhenALaterCliAddsAnArray_RendersItGenerically', () => {
  const lines = reachDetail({
    configured: 3,
    drift: [{ kind: 'x' }],
    unrestoredProjects: [
      { project: 'src/App/App.csproj', reason: 'restore-missing', hint: null, extra: { a: 1 } },
      'Lib',
    ],
    futureFlag: 'not an array',
  });
  assert.deepEqual(lines, [
    'unrestored projects: project: src/App/App.csproj, reason: restore-missing, extra: {"a":1}',
    'unrestored projects: Lib',
  ]);
});

test('reachDetail_WhenTextIsMultilineOrLong_KeepsOneShortLine', () => {
  const [line] = reachDetail({ workspaceLoadFailures: [`first\n| forged | row |\n${'x'.repeat(400)}`] });
  assert.equal(line.includes('\n'), false);
  assert.equal(line.length, 300);
  assert.ok(line.endsWith('…'));
});

test('reachDetail_WhenThereAreManyEntries_CapsAndCountsTheRest', () => {
  const lines = reachDetail({ workspaceLoadFailures: Array.from({ length: 25 }, (_, i) => `failure ${i}`) });
  assert.equal(lines.length, 21);
  assert.equal(lines[20], '…and 5 more (see the CodeCharter log)');
});

test('reachDetail_WhenTheReachHasNoDetail_IsEmpty', () => {
  assert.deepEqual(reachDetail({ isInconclusive: false, unevaluableRules: [], ruleFaults: [] }), []);
});

test('buildComment_WhenARuleFaulted_ListsTheFaultUnderTheInconclusiveRun', () => {
  const report = {
    violations: [],
    run: { reach: { isInconclusive: true, inconclusiveReasons: ['rule-faulted'], ruleFaults: [ruleFault()] } },
  };
  const md = buildComment(report, tally(report), '/repo', {
    severityThreshold: 'info',
    repoFull: 'acme/app',
    sha: 'abc',
    failOn: 'error',
  });
  assert.ok(md.includes('**Inconclusive run** — rule-faulted.'));
  assert.ok(md.includes(`- ${reachFromReport(report).detail[0]}`));
});

test('configErrorsFromLog_WhenTheLogRepeatsErrors_ReturnsEachOnceWithItsFile', () => {
  const log =
    "Config error in .codecharter/config.yml: config.yml(1,1): 'version' is required.\r\n" +
    "Config error in .codecharter/config.yml: config.yml(1,1): 'version' is required.\r\n" +
    'Config error in .codecharter/config.local.yml: bad key\n' +
    'unrelated line\n';
  assert.deepEqual(configErrorsFromLog(log), [
    { file: '.codecharter/config.yml', error: "config.yml(1,1): 'version' is required." },
    { file: '.codecharter/config.local.yml', error: 'bad key' },
  ]);
  assert.deepEqual(configErrorsFromLog(undefined), []);
});

test('configErrorsFromLog_WhenALineRepeatsColonSeparatedParts_ReturnsQuicklyWithTheFirstPartAsFile', () => {
  const long = 'Config error in a: ' + 'a: a'.repeat(50000) + ' '.repeat(50000) + 'x';
  const errors = configErrorsFromLog(long);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'a');
  assert.deepEqual(configErrorsFromLog('Config error in : no file\nConfig error in onlyfile:\n'), []);
});

// A real CLI 1.7.0 report: the sample library references a project file that
// does not exist (German MSBuild messages, as the runner's locale emitted them).
test('reachFromReport_WhenGivenARealCli170ProjectLoadFailure_NamesEachProject', () => {
  const report = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'analyze-1.7.0-project-load-failed.json'), 'utf8')
  );
  const reach = reachFromReport(report);
  assert.deepEqual(reach.reasons, ['project-load-failed']);
  assert.equal(reach.detail.length, 2);
  assert.match(reach.detail[0], /^Project \.\.MissingMissing did not load: \[Failure\] Projektdatei nicht gefunden/);
  assert.match(reach.detail[1], /^Project Lib did not load: \[Failure\] MSBuild-Fehler/);
});
