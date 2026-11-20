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
// The CLI 1.9.0 `gates` section (both gates of the run) is in:
//   coverage-affected-scope-selection-below.json  selection 70% of 100% missed,
//                                                 changed lines met (exit 1)
//   coverage-affected-gates-met.json              both gates met (exit 0)
//   coverage-affected-gates-diff-below.json       changed lines 60% of 100%
//                                                 missed, selection met (exit 1)
//   coverage-affected-gates-both-below.json       both gates missed (exit 1)

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { core } from '../src/deps.js';
import {
  validateRangeFlagValues,
  coverageScopeSummary,
  failedGates,
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
const GATES_MET = 'coverage-affected-gates-met.json';
const DIFF_BELOW = 'coverage-affected-gates-diff-below.json';
const BOTH_BELOW = 'coverage-affected-gates-both-below.json';
const OPTS = { repoFull: 'acme/app', sha: 'abc', failOnThreshold: true };

// A report as an older CLI writes it: the same numbers, no `gates` section.
function withoutGates(report) {
  const legacy = { ...report };
  delete legacy.gates;
  return legacy;
}

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

test('selectionGateFailed: without gates, only exit 1 with met changed lines and a missed overall minimum', () => {
  const below = coverageSummary(withoutGates(fixture(SELECTION_BELOW)));
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
  const md = buildCoverageComment(coverageSummary(withoutGates(fixture(SELECTION_BELOW))), WORKSPACE, {
    ...OPTS,
    exitCode: 0,
  });
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
  assert.equal(
    coverageFooterLine(coverageSummary(fixture(GATES_MET)), true, 0),
    '_Changed lines meet the required minimum._'
  );
});

test('coverageTitle: names the overall gate when it failed the run despite met changed lines', () => {
  const summary = coverageSummary(fixture(SELECTION_BELOW));
  assert.equal(coverageTitle(1, summary), 'Coverage 70.00% is below the required minimum (changed lines met)');
  assert.equal(coverageTitle(0, coverageSummary(fixture(GATES_MET))), 'Diff coverage 100.00% (5/5 changed lines)');
});

// ---------------------------------------------------------------------------
// the gates section (CLI 1.9.0): both gates, each named on its own
// ---------------------------------------------------------------------------

test('failedGates: both gates met reports nothing failed, whatever the exit code', () => {
  const met = coverageSummary(fixture(GATES_MET));
  assert.deepEqual(failedGates(met, 0), { diff: false, selection: false });
  assert.equal(met.met, true, 'the overall verdict is the selection gate');
  assert.equal(met.gates.selection.met, true);
});

test('failedGates: only the changed lines missed, the selection gate passed', () => {
  const summary = coverageSummary(fixture(DIFF_BELOW));
  assert.deepEqual(failedGates(summary, 1), { diff: true, selection: false });
  assert.equal(selectionGateFailed(summary, 1), false);
});

test('failedGates: only the affected selection missed, the changed lines passed', () => {
  const summary = coverageSummary(fixture(SELECTION_BELOW));
  assert.deepEqual(failedGates(summary, 1), { diff: false, selection: true });
  assert.equal(selectionGateFailed(summary, 1), true);
});

test('failedGates: both gates missed are both named', () => {
  const summary = coverageSummary(fixture(BOTH_BELOW));
  assert.deepEqual(failedGates(summary, 1), { diff: true, selection: true });
});

test('failedGates: a gate without a met verdict counts as missed (fails closed)', () => {
  const report = fixture(GATES_MET);
  delete report.gates.selection.met;
  assert.deepEqual(failedGates(coverageSummary(report), 1), { diff: false, selection: true });
});

test('failedGates: without the gates section the exit code and summary decide (older CLI)', () => {
  const { gates, ...legacy } = fixture(SELECTION_BELOW);
  assert.equal(gates.selection.met, false);
  const summary = coverageSummary(legacy);
  assert.equal(summary.gates, null);
  assert.deepEqual(failedGates(summary, 1), { diff: false, selection: true });
  assert.deepEqual(failedGates(summary, 0), { diff: false, selection: false });

  const diffMissed = coverageSummary(fixture('coverage-diff-below.json'));
  assert.deepEqual(failedGates(diffMissed, 1), { diff: true, selection: false });
});

test('coverageSummary: a gate that did not run stays null, and the gates section is parsed', () => {
  const report = fixture(DIFF_BELOW);
  report.gates.selection = null;
  const summary = coverageSummary(report);
  assert.equal(summary.gates.selection, null);
  assert.deepEqual(summary.gates.diff, {
    measured: 5,
    covered: 3,
    percent: 60,
    required: 100,
    met: false,
  });
  assert.equal(coverageSummary({ gates: 'x' }).gates, null);
});

test('buildCoverageComment: both gates met render a Gates table with yes in each row', () => {
  const md = buildCoverageComment(coverageSummary(fixture(GATES_MET)), WORKSPACE, {
    ...OPTS,
    exitCode: 0,
    affectedBy: true,
  });
  assert.match(md, /### Gates\n\n\| Gate \| Measured lines \| Covered \| Percent \| Required \| Met \|/);
  assert.match(md, /\| Changed lines \| 5 \| 5 \| 100\.00% \| 100% \| yes \|/);
  assert.match(md, /\| Affected selection \| 10 \| 10 \| 100\.00% \| 100% \| yes \|/);
  assert.match(md, /the affected selection met its minimum/);
});

test('buildCoverageComment: only the changed lines missed shows that row as not met', () => {
  const md = buildCoverageComment(coverageSummary(fixture(DIFF_BELOW)), WORKSPACE, {
    ...OPTS,
    exitCode: 1,
    affectedBy: true,
  });
  assert.match(md, /\| Changed lines \| 5 \| 3 \| 60\.00% \| 100% \| \*\*no\*\* \|/);
  assert.match(md, /\| Affected selection \| 10 \| 10 \| 100\.00% \| 100% \| yes \|/);
  assert.match(md, /coverage-100\.00%25-brightgreen/, 'the overall badge follows the selection gate');
  assert.doesNotMatch(md, /missed its minimum and failed this run/);
  assert.match(md, /_Cover the changed lines listed above before merging, or lower `min-diff-coverage`\._$/);
});

test('buildCoverageComment: both gates missed names both in the verdict and footer', () => {
  const md = buildCoverageComment(coverageSummary(fixture(BOTH_BELOW)), WORKSPACE, {
    ...OPTS,
    exitCode: 1,
    affectedBy: true,
  });
  assert.match(md, /\| Changed lines \| 5 \| 3 \| 60\.00% \| 100% \| \*\*no\*\* \|/);
  assert.match(md, /\| Affected selection \| 10 \| 7 \| 70\.00% \| 100% \| \*\*no\*\* \|/);
  assert.match(md, /the affected selection missed its minimum and failed this run/);
  assert.match(md, /_The changed lines and overall coverage are below the required minimum\. Cover the changed lines/);
});

test('buildCoverageComment: no gates section means no Gates table', () => {
  const md = buildCoverageComment(coverageSummary(fixture(NO_SCOPE)), WORKSPACE, {
    ...OPTS,
    exitCode: 0,
    affectedBy: true,
  });
  assert.doesNotMatch(md, /### Gates/);
});

test('buildCoverageComment: a skipped badge on a narrowed run is stated once, above the footer', () => {
  const md = buildCoverageComment(coverageSummary(fixture(GATES_MET)), WORKSPACE, {
    ...OPTS,
    exitCode: 0,
    affectedBy: true,
    badgeSkipped: true,
  });
  const note = '_The coverage badge is not updated on `affected-by` runs; only unfiltered runs update it._';
  assert.equal(md.split(note).length - 1, 1);
  assert.ok(md.indexOf(note) < md.lastIndexOf('---'));
  const unfiltered = buildCoverageComment(coverageSummary(fixture(GATES_MET)), WORKSPACE, { ...OPTS, exitCode: 0 });
  assert.doesNotMatch(unfiltered, /coverage badge is not updated/);
});

test('coverageFooterLine and coverageTitle: only the changed lines missed names the changed lines', () => {
  const summary = coverageSummary(fixture(DIFF_BELOW));
  assert.equal(
    coverageFooterLine(summary, true, 1),
    '_Cover the changed lines listed above before merging, or lower `min-diff-coverage`._'
  );
  assert.equal(coverageTitle(1, summary), 'Diff coverage 60.00% (3/5 changed lines) is below the required minimum');
});

test('coverageFooterLine and coverageTitle: both gates missed name both', () => {
  const summary = coverageSummary(fixture(BOTH_BELOW));
  assert.equal(
    coverageFooterLine(summary, true, 1),
    '_The changed lines and overall coverage are below the required minimum. Cover the changed lines and the regions listed above before merging._'
  );
  assert.match(coverageFooterLine(summary, false, 1), /not failing the check \(`fail-on-threshold: false`\)/);
  assert.equal(coverageTitle(1, summary), 'Coverage 70.00% and changed lines 60.00% are below the required minimum');
});

test('resolveCoverageDiffArgs: affected-by stays a range flag for the CLI', async () => {
  assert.deepEqual(await resolveCoverageDiffArgs({ diff: 'a..b', affectedBy: 'true' }, WORKSPACE), [
    '--git-ref',
    'a..b',
    '--affected-by',
    'a..b',
  ]);
});
