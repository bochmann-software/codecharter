'use strict';

// The changed-lines gate of coverage mode: resolving `diff` / `min-diff-coverage`
// into CLI arguments, flattening the report's `diffCoverage` section, and
// rendering the gate so its reach (how many changed lines it measured) is always
// visible.
//
// The fixtures under test/fixtures/ are real `codecharter coverage` reports (CLI
// 1.6.3) of a one-library, one-xUnit-project sample solution whose last commit
// adds one covered and one uncovered method; only the absolute `file` paths were
// replaced. They were produced with:
//   coverage-diff-below.json             --git-ref HEAD~1..HEAD --min-diff-coverage 100
//   coverage-diff-met-whole-below.json   --git-ref HEAD~1..HEAD --min-diff-coverage 50
//   coverage-diff-below-whole-met.json   --git-ref <same commit> --min-coverage 50 --min-diff-coverage 100
//   coverage-diff-no-changed-lines.json  --git-ref over a commit that changes no source line
// The last three show that under a diff gate `summary.hasMetThreshold` carries
// the diff verdict, not the whole-solution one.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { core, exec, github } from '../src/deps.js';
import {
  resolveCoverageGitRef,
  resolveCoverageDiffArgs,
  validateCoverageDiffInputs,
  isPercentInput,
  diffCoverageSummary,
  meetsThreshold,
  coverageSummary,
  buildCoverageComment,
  coverageFooterLine,
  coverageTitle,
  coverageBadgePayload,
  MAX_COMMENT_ROWS,
} from '../src/index.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

const BELOW = 'coverage-diff-below.json';
const MET_WHOLE_BELOW = 'coverage-diff-met-whole-below.json';
const BELOW_WHOLE_MET = 'coverage-diff-below-whole-met.json';
const NO_LINES = 'coverage-diff-no-changed-lines.json';

const OPTS = { repoFull: 'acme/app', sha: 'abc', failOnThreshold: true, exitCode: 1 };

let warnings;
let failures;
let gitCalls;
let reachable;
let saved;
let workspace;

beforeEach(() => {
  warnings = [];
  failures = [];
  gitCalls = [];
  reachable = true;
  saved = {
    warning: core.warning,
    setFailed: core.setFailed,
    execExec: exec.exec,
    payload: github.context.payload,
    eventName: github.context.eventName,
    sha: github.context.sha,
  };
  core.warning = (m) => warnings.push(m);
  core.setFailed = (m) => failures.push(m);
  github.context.payload = {};
  github.context.eventName = 'workflow_dispatch';
  github.context.sha = 'PUSHSHA';
  exec.exec = async (cmd, args, opts) => {
    gitCalls.push([cmd, ...args]);
    if (args.includes('cat-file')) return reachable ? 0 : 128;
    if (args.includes('--is-shallow-repository')) {
      opts.listeners.stdout(Buffer.from('true\n'));
      return 0;
    }
    if (args.includes('merge-base')) {
      opts.listeners.stdout(Buffer.from('MERGEBASE\n'));
      return 0;
    }
    if (args.includes('rev-parse')) {
      opts.listeners.stdout(Buffer.from('PARENTSHA\n'));
      return 0;
    }
    return 0;
  };
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-covdiff-'));
});

afterEach(() => {
  core.warning = saved.warning;
  core.setFailed = saved.setFailed;
  exec.exec = saved.execExec;
  github.context.payload = saved.payload;
  github.context.eventName = saved.eventName;
  github.context.sha = saved.sha;
  fs.rmSync(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveCoverageGitRef
// ---------------------------------------------------------------------------

test('resolveCoverageGitRef: empty and "false" run no diff gate and touch no git', async () => {
  for (const value of ['', '  ', 'false', 'FALSE', undefined]) {
    assert.deepEqual(await resolveCoverageGitRef(value, workspace), { gitRef: null, skipped: false });
  }
  assert.deepEqual(gitCalls, []);
  assert.deepEqual(warnings, []);
});

test('resolveCoverageGitRef: "true" on a pull request is the merge-base..head range', async () => {
  github.context.payload = { pull_request: { base: { sha: 'BASESHA' }, head: { sha: 'HEADSHA' } } };
  assert.deepEqual(await resolveCoverageGitRef('true', workspace), { gitRef: 'MERGEBASE..HEADSHA', skipped: false });
  assert.deepEqual(gitCalls, [
    ['git', '-C', workspace, 'rev-parse', '--is-shallow-repository'],
    ['git', '-C', workspace, 'fetch', '--no-tags', '--depth=1', 'origin', 'BASESHA'],
    ['git', '-C', workspace, 'merge-base', 'BASESHA', 'HEADSHA'],
  ]);
});

test('resolveCoverageGitRef: "true" on a push is the pushed range', async () => {
  github.context.eventName = 'push';
  github.context.payload = { before: 'BEFORESHA' };
  assert.deepEqual(await resolveCoverageGitRef('true', workspace), { gitRef: 'MERGEBASE..PUSHSHA', skipped: false });
  assert.deepEqual(gitCalls[2], ['git', '-C', workspace, 'cat-file', '-e', 'BEFORESHA^{commit}']);
  assert.deepEqual(gitCalls[3], ['git', '-C', workspace, 'merge-base', 'BEFORESHA', 'PUSHSHA']);
});

test('resolveCoverageGitRef: "true" on a push whose before is not in the checkout is parent..sha', async () => {
  github.context.eventName = 'push';
  github.context.payload = { before: 'BEFORESHA' };
  reachable = false;
  assert.deepEqual(await resolveCoverageGitRef('true', workspace), { gitRef: 'PARENTSHA..PUSHSHA', skipped: false });
  assert.deepEqual(warnings, [
    "The push's previous tip BEFORESHA is not a commit in the checkout: the push rewrote history, or the " +
      'checkout does not contain it. Comparing PUSHSHA with its parent instead.',
  ]);
});

test('resolveCoverageGitRef: "true" on a push with the all-zero before is parent..sha', async () => {
  github.context.eventName = 'push';
  github.context.payload = { before: '0000000000000000000000000000000000000000' };
  assert.deepEqual(await resolveCoverageGitRef('true', workspace), { gitRef: 'PARENTSHA..PUSHSHA', skipped: false });
});

test('resolveCoverageGitRef: "true" on another event warns with the event name and gates the whole solution', async () => {
  github.context.eventName = 'workflow_dispatch';
  assert.deepEqual(await resolveCoverageGitRef('true', workspace), { gitRef: null, skipped: true });
  assert.deepEqual(warnings, [
    '`diff: true` did not scope this run: only pull_request and push events have changed lines to compare, ' +
      'and this is a `workflow_dispatch` event. Gating whole-solution coverage instead.',
  ]);
});

test('resolveCoverageGitRef: an explicit range is passed through unchanged', async () => {
  assert.deepEqual(await resolveCoverageGitRef(' origin/main..HEAD ', workspace), {
    gitRef: 'origin/main..HEAD',
    skipped: false,
  });
  assert.deepEqual(gitCalls, [], 'the CLI computes the diff for a range itself');
});

test('validateCoverageDiffInputs: a diff file is rejected with the fix', () => {
  fs.writeFileSync(path.join(workspace, 'changes..diff'), 'patch');
  assert.equal(validateCoverageDiffInputs('changes..diff', '', workspace), false);
  assert.deepEqual(failures, [
    '`diff` points at the file "changes..diff", but coverage mode gates a git ref range, not a diff file. ' +
      "What to do: set `diff: true` to gate the pull request's or push's changed lines, or pass a range " +
      'such as `origin/main..HEAD`.',
  ]);
});

test('validateCoverageDiffInputs: a value that is neither keyword nor range is rejected', () => {
  assert.equal(validateCoverageDiffInputs('main', '', workspace), false);
  assert.deepEqual(failures, [
    "Invalid `diff` input \"main\" for coverage mode. Use 'true'/'false' or a git ref range (e.g. origin/main..HEAD).",
  ]);
});

// ---------------------------------------------------------------------------
// isPercentInput / resolveCoverageDiffArgs
// ---------------------------------------------------------------------------

test('isPercentInput accepts invariant-culture numbers from 0 to 100 only', () => {
  for (const ok of ['0', '100', '99.5', '100.0', '7']) assert.equal(isPercentInput(ok), true, ok);
  for (const bad of ['99,5', '100.1', '-1', '1e2', 'abc', '', '.5', '5.', ' 5']) {
    assert.equal(isPercentInput(bad), false, bad);
  }
});

test('resolveCoverageDiffArgs: a range with a minimum becomes --git-ref and --min-diff-coverage', async () => {
  const args = await resolveCoverageDiffArgs({ diff: 'origin/main..HEAD', minDiffCoverage: ' 100 ' }, workspace);
  assert.deepEqual(args, ['--git-ref', 'origin/main..HEAD', '--min-diff-coverage', '100']);
});

test('resolveCoverageDiffArgs: a range without a minimum leaves the CLI to inherit min-coverage', async () => {
  const args = await resolveCoverageDiffArgs({ diff: 'origin/main..HEAD', minDiffCoverage: '' }, workspace);
  assert.deepEqual(args, ['--git-ref', 'origin/main..HEAD']);
});

test('resolveCoverageDiffArgs: diff off and no minimum adds nothing', async () => {
  assert.deepEqual(await resolveCoverageDiffArgs({}, workspace), []);
  assert.deepEqual(failures, []);
});

test('resolveCoverageDiffArgs: a locale-formatted minimum is rejected before anything runs', async () => {
  assert.equal(await resolveCoverageDiffArgs({ diff: 'true', minDiffCoverage: '99,5' }, workspace), null);
  assert.deepEqual(failures, [
    'Invalid `min-diff-coverage` "99,5". Use a number from 0 to 100 with a dot as the decimal separator, ' +
      'e.g. `100` or `99.5`.',
  ]);
  assert.deepEqual(gitCalls, [], 'validation happens before the range is resolved');
});

test('resolveCoverageDiffArgs: a minimum with diff off is a configuration error', async () => {
  assert.equal(await resolveCoverageDiffArgs({ diff: 'false', minDiffCoverage: '100' }, workspace), null);
  assert.deepEqual(failures, [
    '`min-diff-coverage` is set, but `diff` is off, so there are no changed lines to gate. What to do: set ' +
      '`diff: true` (or a git ref range) to gate the changed lines, or remove `min-diff-coverage`.',
  ]);
});

test('resolveCoverageDiffArgs: a minimum on an event without a range is ignored with a warning', async () => {
  github.context.eventName = 'schedule';
  assert.deepEqual(await resolveCoverageDiffArgs({ diff: 'true', minDiffCoverage: '100' }, workspace), []);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /this is a `schedule` event\. Gating whole-solution coverage instead\.$/);
  assert.equal(warnings[1], '`min-diff-coverage` is ignored because no diff gate runs on this event.');
  assert.deepEqual(failures, []);
});

test('resolveCoverageDiffArgs: an invalid diff value stops the run', async () => {
  assert.equal(await resolveCoverageDiffArgs({ diff: 'main' }, workspace), null);
  assert.match(failures[0], /^Invalid `diff` input "main" for coverage mode/);
});

// ---------------------------------------------------------------------------
// report parsing (real CLI output)
// ---------------------------------------------------------------------------

test('diffCoverageSummary reads the fields of a real diffCoverage section', () => {
  const d = diffCoverageSummary(fixture(BELOW).diffCoverage);
  assert.deepEqual(
    { ...d, regions: d.regions.map((r) => [r.relativeFile, r.method, r.lines]) },
    {
      gitRef: 'HEAD~1..HEAD',
      changed: 5,
      covered: 3,
      percent: 60,
      required: 100,
      source: '--min-diff-coverage',
      met: false,
      regions: [['src/Lib/Calc.cs', 'Negate', [17, 18]]],
    }
  );
});

test('diffCoverageSummary: a gate over zero changed lines has no percent but passes', () => {
  const d = diffCoverageSummary(fixture(NO_LINES).diffCoverage);
  assert.equal(d.changed, 0);
  assert.equal(d.covered, 0);
  assert.equal(d.percent, null);
  assert.equal(d.met, true);
  assert.equal(d.source, 'inherited');
});

test('diffCoverageSummary: no section, or a malformed one, degrades to "no gate" or "nothing measured"', () => {
  assert.equal(diffCoverageSummary(undefined), null);
  assert.equal(diffCoverageSummary(null), null);
  assert.equal(diffCoverageSummary('x'), null);
  assert.deepEqual(diffCoverageSummary({}), {
    gitRef: '',
    changed: 0,
    covered: 0,
    percent: null,
    required: null,
    source: 'default',
    met: false,
    regions: [],
  });
});

test('coverageSummary: under a diff gate the whole-solution verdict comes from its own numbers', () => {
  // The CLI says hasMetThreshold: true here (the diff gate passed) at 70% of 100%.
  const metDiff = coverageSummary(fixture(MET_WHOLE_BELOW));
  assert.equal(fixture(MET_WHOLE_BELOW).summary.hasMetThreshold, true);
  assert.equal(metDiff.met, false);
  assert.equal(metDiff.diff.met, true);

  // And hasMetThreshold: false here (the diff gate failed) at 70% of 50%.
  const failedDiff = coverageSummary(fixture(BELOW_WHOLE_MET));
  assert.equal(fixture(BELOW_WHOLE_MET).summary.hasMetThreshold, false);
  assert.equal(failedDiff.met, true);
  assert.equal(failedDiff.diff.met, false);
});

test('coverageSummary: without a diff gate the CLI verdict is used unchanged', () => {
  const report = fixture(BELOW);
  delete report.diffCoverage;
  report.summary.hasMetThreshold = true; // deliberately contradicts 70% < 100%
  const s = coverageSummary(report);
  assert.equal(s.met, true);
  assert.equal(s.diff, null);
});

test('coverageBadgePayload keeps reporting whole-solution coverage under a diff gate', () => {
  const badge = coverageBadgePayload(coverageSummary(fixture(MET_WHOLE_BELOW)));
  assert.deepEqual(badge.coverage, {
    percent: 70,
    requiredPercent: 100,
    met: false,
    coveredLines: 7,
    measurableLines: 10,
  });
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test('buildCoverageComment shows the diff gate with its reach, verdict and uncovered changed lines', () => {
  const md = buildCoverageComment(coverageSummary(fixture(BELOW)), '/home/runner/work/sample/sample', OPTS);

  assert.match(md, /### Changed lines \(`HEAD~1\.\.HEAD`\)/);
  assert.match(md, /badge\/diff%20coverage-60\.00%25-red/);
  assert.match(
    md,
    /3 of 5 changed measurable lines covered \(threshold from `--min-diff-coverage`\): \*\*not met\*\*\./
  );
  assert.match(md, /<summary>src\/Lib\/Calc\.cs \(1 uncovered changed region\(s\)\)<\/summary>/);
  assert.match(
    md,
    /\| 17-18 \| Negate \| \[src\/Lib\/Calc\.cs:17\]\(https:\/\/github\.com\/acme\/app\/blob\/abc\/src\/Lib\/Calc\.cs#L17\) \|/
  );
  // Whole-solution coverage is still shown, marked as reported only.
  assert.match(md, /badge\/coverage-70\.00%25-yellow/);
  assert.match(
    md,
    /7 of 10 measurable lines covered \(threshold from `default`; whole solution reported only, the changed-lines gate decides this run\)\./
  );
  assert.match(md, /<summary>src\/Lib\/Calc\.cs \(1 uncovered region\(s\)\)<\/summary>/);
  assert.match(md, /\| 17-19 \| Negate \|/);
  assert.match(md, /Cover the changed lines listed above before merging, or lower `min-diff-coverage`\._$/);
});

test('buildCoverageComment states a gate over zero changed lines explicitly', () => {
  const md = buildCoverageComment(coverageSummary(fixture(NO_LINES)), '/w', { ...OPTS, exitCode: 0 });
  assert.match(md, /badge\/diff%20coverage-no%20changed%20lines-lightgrey/);
  assert.match(md, /\*\*No measurable line changed\*\*, so the changed-lines gate checked 0 lines and passed\./);
  assert.doesNotMatch(md, /changed measurable lines covered/);
  assert.match(md, /_The changed-lines gate passed without a measurable changed line to check\._$/);
});

test('buildCoverageComment marks a met diff gate green', () => {
  const md = buildCoverageComment(coverageSummary(fixture(MET_WHOLE_BELOW)), '/w', { ...OPTS, exitCode: 0 });
  assert.match(md, /badge\/diff%20coverage-60\.00%25-brightgreen/);
  assert.match(md, /badge\/required-50%25-blue/);
  assert.match(md, /: \*\*met\*\*\./);
  assert.match(md, /_Changed lines meet the required minimum\._$/);
});

test('buildCoverageComment renders an unknown diff percent and a missing minimum without inventing numbers', () => {
  const summary = coverageSummary({
    ...fixture(BELOW),
    diffCoverage: { gitRef: '', measurableChangedLines: 2, coveredChangedLines: 1, met: false },
  });
  const md = buildCoverageComment(summary, '/w', OPTS);
  assert.match(md, /^### Changed lines$/m);
  assert.match(md, /badge\/diff%20coverage-unknown-red\?style=flat-square\)$/m);
  assert.doesNotMatch(md.split('### Changed lines')[1].split('\n')[2], /required/);
});

test('buildCoverageComment truncates a long list of uncovered changed regions', () => {
  const regions = Array.from({ length: MAX_COMMENT_ROWS + 3 }, (_, i) => ({
    relativeFile: `src/F${String(i).padStart(3, '0')}.cs`,
    method: 'M',
    lines: [i + 1],
  }));
  const report = fixture(BELOW);
  report.diffCoverage.uncoveredChangedRegions = regions;
  report.uncoveredRegions = [];
  const md = buildCoverageComment(coverageSummary(report), '/w', OPTS);
  assert.match(md, new RegExp(`Showing the first ${MAX_COMMENT_ROWS} uncovered changed regions; the full report`));
});

test('coverageFooterLine speaks for the diff gate when one ran', () => {
  const below = coverageSummary(fixture(BELOW_WHOLE_MET));
  assert.equal(
    coverageFooterLine(below, false),
    '_Changed-line coverage is below the required minimum; not failing the check (`fail-on-threshold: false`)._'
  );
  assert.equal(
    coverageFooterLine(below, true),
    '_Cover the changed lines listed above before merging, or lower `min-diff-coverage`._'
  );
});

test('coverageTitle names the diff gate when it decided the run', () => {
  assert.equal(
    coverageTitle(1, coverageSummary(fixture(BELOW))),
    'Diff coverage 60.00% (3/5 changed lines) is below the required minimum'
  );
  assert.equal(coverageTitle(0, coverageSummary(fixture(MET_WHOLE_BELOW))), 'Diff coverage 60.00% (3/5 changed lines)');
  assert.equal(
    coverageTitle(0, coverageSummary(fixture(NO_LINES))),
    'Diff coverage: no measurable changed lines (gate passed over 0 lines)'
  );
  const unknown = coverageSummary({ ...fixture(BELOW), diffCoverage: { measurableChangedLines: 1 } });
  assert.equal(coverageTitle(1, unknown), 'Diff coverage unknown (0/1 changed lines) is below the required minimum');
  assert.equal(coverageTitle(2, coverageSummary(fixture(BELOW))), 'Tests failed or coverage was incomplete');
});

test('validateCoverageDiffInputs: usable inputs pass without touching git', () => {
  assert.equal(validateCoverageDiffInputs('', '', workspace), true);
  assert.equal(validateCoverageDiffInputs('true', '100', workspace), true);
  assert.equal(validateCoverageDiffInputs('origin/main..HEAD', '99.5', workspace), true);
  assert.deepEqual(failures, []);
  assert.deepEqual(gitCalls, []);
});

// ---------------------------------------------------------------------------
// whole-solution verdict under a diff gate: the CLI's exact comparison
// ---------------------------------------------------------------------------

test('meetsThreshold compares covered*100 against required*total exactly, like the CLI', () => {
  assert.equal(meetsThreshold(19999, 20000, 99.995), true, '99.995% exactly is met');
  assert.equal(meetsThreshold(19998, 20000, 99.995), false);
  assert.equal(meetsThreshold(1, 3, 33.33), true);
  assert.equal(meetsThreshold(99, 100, 100), false);
  assert.equal(meetsThreshold(0, 0, 100), true, 'no measurable line counts as met');
  assert.equal(meetsThreshold(1, 10, 1e-7), true, 'exponent notation falls back to floating point');
  assert.equal(meetsThreshold(0, 10, 1e-7), false);
});

test('coverageSummary: 19999 of 20000 lines at 99.995% is met although the floored percent is 99.99', () => {
  const report = fixture(MET_WHOLE_BELOW);
  report.summary = {
    ...report.summary,
    totalLines: 20000,
    coveredLines: 19999,
    percent: 99.99,
    minimumRequiredPercent: 99.995,
  };
  assert.equal(coverageSummary(report).met, true);
  report.summary.coveredLines = 19998;
  assert.equal(coverageSummary(report).met, false);
});
