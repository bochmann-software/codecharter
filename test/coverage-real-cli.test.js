import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { coverageSummary, failedGates, buildCoverageComment, coverageBadgePayload } from '../src/index.js';

// Reports written by a real CodeCharter CLI 1.9.0 (`coverage --git-ref R --affected-by R`,
// the arguments the action passes; the action never passes `--gate-total-coverage`) on a
// two-library sample solution, with the sample's paths
// rewritten to the runner workspace. They pin the contract the hand-built
// fixtures only assume.
//   diff-below            exit 1  changed lines and selection both 25%
//   met                   exit 0  both gates met, LibB.Tests skipped
//   escalated             exit 0  central file changed, every suite ran
//   cross-check-failed    exit 3  noDataReason crossCheckFailed, numbers still present
//   incomplete            exit 2  selected suite has no coverage files, percent null

const WORKSPACE = '/home/runner/work/sample/sample';
const OPTS = { repoFull: 'acme/app', sha: 'abc', failOnThreshold: true, affectedBy: true };
const load = (name) =>
  coverageSummary(
    JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, 'fixtures', `coverage-real-cli-1.9.0-${name}.json`), 'utf8')
    )
  );

test('real CLI report: a missed changed-lines gate fails both gates at exit 1', () => {
  const summary = load('diff-below');
  assert.deepEqual(failedGates(summary, 1), { diff: true, selection: true });
  assert.equal(summary.gates.diff.percent, 25);
  assert.deepEqual(summary.scope.skipped, ['LibB.Tests']);
  assert.equal(summary.met, false);
});

test('real CLI report: a met run passes both gates and ran the narrowed selection', () => {
  const summary = load('met');
  assert.deepEqual(failedGates(summary, 0), { diff: false, selection: false });
  assert.equal(summary.met, true);
  assert.equal(summary.scope.escalated, false);
});

test('real CLI report: an escalated selection states its reason', () => {
  const summary = load('escalated');
  assert.equal(summary.scope.escalated, true);
  assert.deepEqual(summary.scope.skipped, []);
  const md = buildCoverageComment(summary, WORKSPACE, { ...OPTS, exitCode: 0 });
  assert.match(md, /Selection escalated to all test projects:\*\* 'Directory\.Build\.props' is a central file/);
});

test('real CLI report: a failed completeness check keeps its numbers but gets no verdict or coverage badge', () => {
  const summary = load('cross-check-failed');
  assert.equal(summary.noDataReason, 'crossCheckFailed');
  assert.equal(summary.percent, 100);
  assert.equal(summary.scope.crossCheckFailureFile, `${WORKSPACE}/src/LibA/Orph.cs`);
  assert.equal(coverageBadgePayload(summary).coverage, null);
  const md = buildCoverageComment(summary, WORKSPACE, { ...OPTS, exitCode: 3 });
  assert.match(md, /src\/LibA\/Orph\.cs/);
  assert.match(md, /coverage-no%20data/);
});

test('real CLI report: an incomplete run (exit 2) has a null percent and absolute unmeasured project paths shown relative', () => {
  const summary = load('incomplete');
  assert.equal(summary.percent, null);
  assert.equal(summary.noDataReason, 'noCoverageFiles');
  assert.deepEqual(failedGates(summary, 2), { diff: false, selection: false });
  assert.deepEqual(summary.gates.selection.unmeasuredProjects, [`${WORKSPACE}/src/LibA`]);
  const md = buildCoverageComment(summary, WORKSPACE, { ...OPTS, exitCode: 2 });
  assert.match(md, /no test project measured 1 affected project\(s\): src\/LibA\./);
  assert.equal(coverageBadgePayload(summary).coverage, null);
});
