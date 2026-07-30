'use strict';

// The per-project test table in the coverage summary: what one row says, how the
// rows are ordered, that the totals row is always the last one, and how the
// table degrades when the assembled report would blow GitHub's size limit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCoverageComment,
  coverageSummary,
  projectFailed,
  projectResultCell,
  sortTestProjects,
  testTableRows,
  MAX_COMMENT_CHARS,
} from '../src/index.js';

const WORKSPACE = '/repo';
const OPTS = { repoFull: 'acme/app', sha: 'abc', failOnThreshold: true, exitCode: 1 };

/** A coverage report whose only variable part is its test projects. */
function reportWith(testResults) {
  return {
    summary: {
      totalLines: 120,
      coveredLines: 118,
      percent: 98.33,
      minimumRequiredPercent: 100,
      hasMetThreshold: false,
      minimumRequiredPercentSource: 'config',
    },
    testResults,
    uncoveredRegions: [],
  };
}

/** A passing project that reports counts (CLI v1.4.5 and newer). */
function passing(name, counts = { total: 4, passed: 4, failed: 0, skipped: 0 }) {
  return { project: name, exitCode: 0, succeeded: true, failureReason: null, ...counts };
}

/** The rendered comment for a set of projects, at the requested detail level. */
function commentFor(testResults) {
  return buildCoverageComment(coverageSummary(reportWith(testResults)), WORKSPACE, OPTS);
}

/** The table rows of a rendered comment, header included. */
function tableLines(markdown) {
  return markdown.split('\n').filter((l) => l.startsWith('|'));
}

// ---------------------------------------------------------------------------
// one row
// ---------------------------------------------------------------------------

test('projectFailed: succeeded wins, and an older row falls back to the exit code', () => {
  assert.equal(projectFailed({ succeeded: true, exitCode: 1 }), false);
  assert.equal(projectFailed({ succeeded: false, exitCode: 0 }), true);
  assert.equal(projectFailed({ exitCode: 0 }), false);
  assert.equal(projectFailed({ exitCode: 2 }), true);
  assert.equal(projectFailed({}), false);
});

test('projectResultCell: a failure shows the CLI wording, or the exit code, or nothing', () => {
  assert.equal(projectResultCell(passing('A.Tests')), '✅');
  assert.equal(
    projectResultCell({ project: 'A.Tests', succeeded: false, exitCode: 143, failureReason: 'timed out after 1800s' }),
    '❌ timed out after 1800s'
  );
  assert.equal(projectResultCell({ project: 'A.Tests', succeeded: false, exitCode: 2 }), '❌ exit code 2');
  assert.equal(projectResultCell({ project: 'A.Tests', succeeded: false, exitCode: 0 }), '❌');
});

test('testTableRows: a failing project keeps its reason and shows its counts', () => {
  const rows = testTableRows(
    [
      {
        project: 'A.Tests',
        exitCode: 1,
        succeeded: false,
        failureReason: 'tests failed (exit code 1)',
        total: 10,
        passed: 8,
        failed: 2,
        skipped: 0,
      },
    ],
    { total: 10, passed: 8, failed: 2, skipped: 0 }
  );
  assert.equal(rows[2], '| A.Tests | ❌ tests failed (exit code 1) | 10 | 8 | 2 | 0 |');
  assert.equal(rows[3], '| **Σ 1 project** | ❌ | **10** | **8** | **2** | **0** |');
});

test('testTableRows: renders a passing project with its counts and the header', () => {
  assert.deepEqual(
    testTableRows([passing('A.Tests', { total: 3, passed: 2, failed: 1, skipped: 0 })], {
      total: 3,
      passed: 2,
      failed: 1,
      skipped: 0,
    }),
    [
      '| Project | Result | Tests | Passed | Failed | Skipped |',
      '|---------|--------|-------|--------|--------|---------|',
      '| A.Tests | ✅ | 3 | 2 | 1 | 0 |',
      '| **Σ 1 project** | ✅ | **3** | **2** | **1** | **0** |',
      '',
    ]
  );
});

test('testTableRows: a run with no test projects renders nothing at all', () => {
  assert.deepEqual(testTableRows([], null), []);
  assert.deepEqual(testTableRows(undefined, null), []);
});

test('testTableRows: a project name with a pipe cannot break the table', () => {
  const rows = testTableRows([passing('A|B\\C.Tests')], null);
  assert.match(rows[2], /\| A\\\|B\\\\C\.Tests \|/);
});

test('testTableRows: a newline in a name or a reason cannot break out of the row', () => {
  const rows = testTableRows(
    [
      {
        project: 'A.Tests\n| **Σ 9 projects** | ✅ | 9 | 9 | 0 | 0 |',
        exitCode: 1,
        succeeded: false,
        failureReason: 'crashed\r\n## Everything is fine',
      },
    ],
    null
  );
  assert.equal(rows.length, 5, 'header, separator, one project row, the totals row and the trailing blank line');
  assert.doesNotMatch(rows[2], /[\r\n]/, 'the row stays on one line');
  assert.match(
    rows[2],
    /^\| A\.Tests \\\| \*\*Σ 9 projects\*\* \\\| ✅ \\\| 9 \\\| 9 \\\| 0 \\\| 0 \\\| \| ❌ crashed ## Everything is fine \|/
  );
});

test('testTableRows: a nameless project still gets a row', () => {
  const rows = testTableRows([{ exitCode: 0, succeeded: true }], null);
  assert.match(rows[2], /^\| \(unknown\) \| ✅ \|/);
});

test('testTableRows: non-object entries are ignored', () => {
  assert.deepEqual(testTableRows([null, 'nope'], null), []);
});

// ---------------------------------------------------------------------------
// ordering and totals
// ---------------------------------------------------------------------------

test('sortTestProjects: failing projects first, then alphabetically', () => {
  const sorted = sortTestProjects([
    passing('Z.Tests'),
    { project: 'M.Tests', exitCode: 1, succeeded: false },
    passing('A.Tests'),
    { project: 'B.Tests', exitCode: 1, succeeded: false },
  ]);
  assert.deepEqual(
    sorted.map((p) => p.project),
    ['B.Tests', 'M.Tests', 'A.Tests', 'Z.Tests']
  );
});

test('buildCoverageComment: rows are ordered failing-first and closed by the totals row', () => {
  const md = commentFor([
    passing('Z.Tests', { total: 1, passed: 1, failed: 0, skipped: 0 }),
    passing('A.Tests', { total: 2, passed: 2, failed: 0, skipped: 0 }),
    {
      project: 'M.Tests',
      exitCode: 1,
      succeeded: false,
      failureReason: 'tests failed (exit code 1)',
      total: 3,
      passed: 1,
      failed: 2,
      skipped: 0,
    },
  ]);
  const rows = tableLines(md);
  assert.match(rows[2], /^\| M\.Tests \| ❌ tests failed/);
  assert.match(rows[3], /^\| A\.Tests \|/);
  assert.match(rows[4], /^\| Z\.Tests \|/);
  assert.equal(rows[5], '| **Σ 3 projects** | ❌ | **6** | **4** | **2** | **0** |');
});

test('buildCoverageComment: the totals row is present even when no project reports counts', () => {
  const md = commentFor([
    { project: 'A.Tests', exitCode: 0, succeeded: true },
    { project: 'B.Tests', exitCode: 0, succeeded: true },
  ]);
  assert.match(md, /\| \*\*Σ 2 projects\*\* \| ✅ \| — \| — \| — \| — \|/);
});

test('buildCoverageComment: a mixed report sums only the projects that report counts', () => {
  const md = commentFor([
    passing('A.Tests', { total: 5, passed: 5, failed: 0, skipped: 0 }),
    { project: 'B.Tests', exitCode: 0, succeeded: true },
  ]);
  assert.match(md, /\| B\.Tests \| ✅ \| — \| — \| — \| — \|/);
  assert.match(md, /\| \*\*Σ 2 projects\*\* \| ✅ \| \*\*5\*\* \|/);
});

test('buildCoverageComment: the coverage line is untouched by the table', () => {
  const md = commentFor([passing('A.Tests')]);
  assert.match(md, /^118 of 120 measurable lines covered \(threshold from `config`\)\.$/m);
});

// ---------------------------------------------------------------------------
// degradation
// ---------------------------------------------------------------------------

/** A project whose name alone is long enough to make the table huge. */
function bulky(index, failed) {
  const name = `Contoso.Enterprise.Platform.Services.Module${String(index).padStart(4, '0')}.${'Sub'.repeat(40)}.Tests`;
  return failed
    ? {
        project: name,
        exitCode: 1,
        succeeded: false,
        failureReason: 'tests failed (exit code 1)',
        total: 5,
        passed: 4,
        failed: 1,
        skipped: 0,
      }
    : passing(name, { total: 5, passed: 5, failed: 0, skipped: 0 });
}

test('buildCoverageComment: an oversized table drops the passing rows but keeps the failing ones', () => {
  const projects = [bulky(0, true), ...Array.from({ length: 400 }, (_, i) => bulky(i + 1, false))];
  const md = commentFor(projects);

  assert.ok(md.length <= MAX_COMMENT_CHARS, `expected the report to fit the budget, got ${md.length}`);
  assert.match(md, /Contoso\.Enterprise\.Platform\.Services\.Module0000\./, 'the failing project stays');
  assert.doesNotMatch(md, /Module0001\./, 'the passing projects are gone');
  assert.match(md, /_… 400 passing project\(s\) omitted to keep this report within GitHub's size limit\._/);
  assert.match(md, /\| \*\*Σ 401 projects\*\* \| ❌ \| \*\*2005\*\* \|/);
});

test('buildCoverageComment: when even the failing rows do not fit, only the totals survive', () => {
  const projects = Array.from({ length: 400 }, (_, i) => bulky(i, true));
  const md = commentFor(projects);

  assert.ok(md.length <= MAX_COMMENT_CHARS, `expected the report to fit the budget, got ${md.length}`);
  assert.doesNotMatch(md, /Contoso\.Enterprise/, 'no per-project row survives');
  assert.doesNotMatch(md, /passing project\(s\) omitted/);
  assert.match(md, /\| Project \| Result \| Tests \| Passed \| Failed \| Skipped \|/);
  assert.match(md, /\| \*\*Σ 400 projects\*\* \| ❌ \| \*\*2000\*\* \|/);
});

test('buildCoverageComment: a report that fits keeps every row', () => {
  const md = commentFor(Array.from({ length: 20 }, (_, i) => passing(`P${String(i).padStart(2, '0')}.Tests`)));
  assert.equal(tableLines(md).length, 20 + 3, 'header, separator, 20 rows and the totals row');
  assert.doesNotMatch(md, /omitted/);
});
