'use strict';

// The `affected-by` test selection of coverage mode: validating the boolean
// range-flag inputs, flattening the report's `coverageScope` section, and
// rendering both gates of an `--affected-by` run (overall coverage over the
// selected test projects, and the changed lines).
//
// The fixtures are hand-built from coverage-diff-met-whole-below.json, because
// no released CLI writes `coverageScope` into its JSON report yet; the section
// follows the shape of the MCP `run_coverage` result (`selectedSuites`,
// `skippedSuites`, `crossCheckFailureFile`):
//   coverage-affected-no-scope.json               an --affected-by run of a CLI
//                                                 without the section, changed
//                                                 lines met (exit 0)
//   coverage-affected-scope-selection-below.json  the section present, changed
//                                                 lines met, overall 70% of 100%
//                                                 (a double-gate CLI exits 1)
//   coverage-affected-cross-check-failed.json     only the section, naming the
//                                                 changed file without coverage
//                                                 data (exit 3)

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { core } from '../src/deps.js';
import {
  validateRangeFlagValues,
  coverageScopeSummary,
  selectionGateFailed,
  affectedSelectionLines,
  coverageSummary,
  buildCoverageComment,
  coverageFooterLine,
  coverageTitle,
  resolveCoverageDiffArgs,
  MAX_COMMENT_ROWS,
} from '../src/index.js';

const WORKSPACE = '/home/runner/work/sample/sample';
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));
const NO_SCOPE = 'coverage-affected-no-scope.json';
const SELECTION_BELOW = 'coverage-affected-scope-selection-below.json';
const CROSS_CHECK = 'coverage-affected-cross-check-failed.json';
const OPTS = { repoFull: 'acme/app', sha: 'abc', failOnThreshold: true };

let failures;
let savedSetFailed;

beforeEach(() => {
  failures = [];
  savedSetFailed = core.setFailed;
  core.setFailed = (m) => failures.push(m);
});

afterEach(() => {
  core.setFailed = savedSetFailed;
});

// ---------------------------------------------------------------------------
// validateRangeFlagValues
// ---------------------------------------------------------------------------

test('validateRangeFlagValues: empty, true and false in any case are usable', () => {
  assert.equal(validateRangeFlagValues({}), true);
  assert.equal(validateRangeFlagValues({ affectedBy: ' TRUE ', failOnUnmeasuredProjects: 'False' }), true);
  assert.equal(validateRangeFlagValues({ affectedBy: '', failOnUnmeasuredProjects: '  ' }), true);
  assert.deepEqual(failures, []);
});

test('validateRangeFlagValues: a typo in affected-by fails instead of switching the selection off', () => {
  assert.equal(validateRangeFlagValues({ affectedBy: ' yes ' }), false);
  assert.deepEqual(failures, ['Invalid `affected-by` "yes". Use `true` or `false`.']);
});

test('validateRangeFlagValues: a typo in fail-on-unmeasured-projects names that input', () => {
  assert.equal(validateRangeFlagValues({ affectedBy: 'true', failOnUnmeasuredProjects: '1' }), false);
  assert.deepEqual(failures, ['Invalid `fail-on-unmeasured-projects` "1". Use `true` or `false`.']);
});

test('resolveCoverageDiffArgs: an invalid affected-by stops before any range is resolved', async () => {
  assert.equal(await resolveCoverageDiffArgs({ diff: 'a..b', affectedBy: 'on' }, WORKSPACE), null);
  assert.deepEqual(failures, ['Invalid `affected-by` "on". Use `true` or `false`.']);
});

// ---------------------------------------------------------------------------
// coverageScopeSummary
// ---------------------------------------------------------------------------

test('coverageScopeSummary: reads the selection of a coverageScope section', () => {
  assert.deepEqual(coverageScopeSummary(fixture(SELECTION_BELOW).coverageScope), {
    selected: ['Lib.Tests'],
    skipped: ['App.Tests', 'Web.Tests'],
    crossCheckFailureFile: null,
  });
  assert.equal(
    coverageScopeSummary(fixture(CROSS_CHECK).coverageScope).crossCheckFailureFile,
    `${WORKSPACE}/src/App/Widget.cs`
  );
});

test('coverageScopeSummary: no section, or a malformed one, degrades to null or empty lists', () => {
  assert.equal(coverageScopeSummary(undefined), null);
  assert.equal(coverageScopeSummary(null), null);
  assert.equal(coverageScopeSummary('Lib.Tests'), null);
  assert.deepEqual(
    coverageScopeSummary({ selectedSuites: ['A', 3, null], skippedSuites: 'B', crossCheckFailureFile: 7 }),
    {
      selected: ['A'],
      skipped: [],
      crossCheckFailureFile: null,
    }
  );
});

test('coverageSummary: carries the scope when present and null when the CLI wrote none', () => {
  assert.deepEqual(coverageSummary(fixture(SELECTION_BELOW)).scope.skipped, ['App.Tests', 'Web.Tests']);
  assert.equal(coverageSummary(fixture(NO_SCOPE)).scope, null);
  assert.equal(coverageSummary(null).scope, null);
});

// ---------------------------------------------------------------------------
// selectionGateFailed
// ---------------------------------------------------------------------------

test('selectionGateFailed: only exit 1 with met changed lines and a missed overall minimum', () => {
  const below = coverageSummary(fixture(SELECTION_BELOW));
  assert.equal(below.met, false);
  assert.equal(below.diff.met, true);
  assert.equal(selectionGateFailed(below, 1), true);
  assert.equal(selectionGateFailed(below, 0), false, 'a changed-lines-only CLI passes this run');
  assert.equal(selectionGateFailed(below, 2), false);

  const diffMissed = coverageSummary(fixture('coverage-diff-below.json'));
  assert.equal(selectionGateFailed(diffMissed, 1), false, 'the changed lines decided');
  const noDiff = coverageSummary(fixture('coverage-1.7.0-below.json'));
  assert.equal(selectionGateFailed(noDiff, 1), false, 'no changed-lines gate ran');
});

// ---------------------------------------------------------------------------
// affectedSelectionLines
// ---------------------------------------------------------------------------

test('affectedSelectionLines: empty when the run was not narrowed', () => {
  assert.deepEqual(affectedSelectionLines(coverageSummary(fixture('coverage-diff-below.json')), WORKSPACE, false), []);
});

test('affectedSelectionLines: names how many ran and lists the skipped test projects', () => {
  const md = affectedSelectionLines(coverageSummary(fixture(SELECTION_BELOW)), WORKSPACE, true).join('\n');
  assert.match(md, /^### Test selection \(`affected-by`\)/);
  assert.match(md, /Ran 1 of 3 test project\(s\), the ones the change affects; 2 skipped\./);
  assert.match(md, /<summary>Skipped test projects<\/summary>\n\nApp\.Tests, Web\.Tests\n/);
  assert.doesNotMatch(md, /Completeness check failed/);
});

test('affectedSelectionLines: a scope that skipped nothing has no skipped list', () => {
  const summary = coverageSummary({ coverageScope: { selectedSuites: ['A.Tests'], skippedSuites: [] } });
  const md = affectedSelectionLines(summary, WORKSPACE, true).join('\n');
  assert.match(md, /Ran 1 of 1 test project\(s\), the ones the change affects; 0 skipped\./);
  assert.doesNotMatch(md, /Skipped test projects/);
});

test('affectedSelectionLines: caps a long skipped list and escapes the names', () => {
  const skipped = Array.from({ length: MAX_COMMENT_ROWS + 2 }, (_, i) => `S${i}_Tests`);
  const summary = coverageSummary({ coverageScope: { selectedSuites: [], skippedSuites: skipped } });
  const md = affectedSelectionLines(summary, WORKSPACE, false).join('\n');
  assert.ok(md.includes('S0\\_Tests, S1\\_Tests'));
  assert.ok(md.includes(`S${MAX_COMMENT_ROWS - 1}\\_Tests, and 2 more\n`));
  assert.ok(!md.includes(`S${MAX_COMMENT_ROWS}\\_Tests`));
});

test('affectedSelectionLines: names the changed file the completeness check found unmeasured', () => {
  const md = affectedSelectionLines(coverageSummary(fixture(CROSS_CHECK)), WORKSPACE, true).join('\n');
  assert.match(md, /\*\*Completeness check failed:\*\* the changed file src\/App\/Widget\.cs has no coverage data/);
});

test('affectedSelectionLines: without a coverageScope it falls back to the test table', () => {
  const md = affectedSelectionLines(coverageSummary(fixture(NO_SCOPE)), WORKSPACE, true).join('\n');
  assert.match(md, /Ran 1 test project\(s\) selected by `--affected-by`\. The CLI did not report which test/);
  assert.doesNotMatch(md, /skipped\./);
});

// ---------------------------------------------------------------------------
// both gates in the comment, title and footer
// ---------------------------------------------------------------------------

test('buildCoverageComment: a narrowed run names the selection, not the whole solution', () => {
  const md = buildCoverageComment(coverageSummary(fixture(NO_SCOPE)), WORKSPACE, {
    ...OPTS,
    exitCode: 0,
    affectedBy: true,
  });
  assert.match(md, /affected selection reported only, the changed-lines gate decides this run/);
  assert.doesNotMatch(md, /whole solution/);
  assert.match(md, /coverage-70\.00%25-yellow/);
  assert.ok(md.indexOf('### Test selection') < md.indexOf('### Changed lines'));
  assert.match(md, /_Changed lines meet the required minimum\._$/);
});

test('buildCoverageComment: a coverageScope alone marks the run as narrowed', () => {
  const md = buildCoverageComment(coverageSummary(fixture(SELECTION_BELOW)), WORKSPACE, { ...OPTS, exitCode: 0 });
  assert.match(md, /affected selection reported only/);
  assert.match(md, /Ran 1 of 3 test project\(s\)/);
});

test('buildCoverageComment: a failed overall gate with met changed lines is red and says it decided', () => {
  const md = buildCoverageComment(coverageSummary(fixture(SELECTION_BELOW)), WORKSPACE, {
    ...OPTS,
    exitCode: 1,
    affectedBy: true,
  });
  assert.match(md, /coverage-70\.00%25-red/);
  assert.match(md, /the affected selection missed its minimum and failed this run\)/);
  assert.match(md, /5 of 5 changed measurable lines covered .*\*\*met\*\*/);
  assert.match(
    md,
    /_The changed lines are covered, but overall coverage is below the required minimum\. Cover the regions/
  );
});

test('buildCoverageComment: no data still shows the selection and the completeness culprit', () => {
  const md = buildCoverageComment(coverageSummary(fixture(CROSS_CHECK)), WORKSPACE, {
    ...OPTS,
    exitCode: 3,
    affectedBy: true,
  });
  assert.match(md, /coverage-no%20data/);
  assert.match(md, /Ran 1 of 2 test project\(s\)/);
  assert.match(md, /src\/App\/Widget\.cs has no coverage data/);
  assert.match(md, /_No coverage data was produced, so the gate could not be evaluated\._$/);
});

test('coverageFooterLine: a failed overall gate respects fail-on-threshold', () => {
  const summary = coverageSummary(fixture(SELECTION_BELOW));
  assert.match(coverageFooterLine(summary, true, 1), /Cover the regions listed above before merging/);
  assert.match(coverageFooterLine(summary, false, 1), /not failing the check \(`fail-on-threshold: false`\)/);
  assert.equal(coverageFooterLine(summary, true, 0), '_Changed lines meet the required minimum._');
});

test('coverageTitle: names the overall gate when it failed the run despite met changed lines', () => {
  const summary = coverageSummary(fixture(SELECTION_BELOW));
  assert.equal(coverageTitle(1, summary), 'Coverage 70.00% is below the required minimum (changed lines met)');
  assert.equal(coverageTitle(0, summary), 'Diff coverage 100.00% (5/5 changed lines)');
});
