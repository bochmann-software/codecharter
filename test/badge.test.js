'use strict';

// The opt-in badge payload: the aggregate numbers the portal needs to serve
// repository badges. Two things matter and are pinned here: the exact shape of
// the object (the portal is built against this contract), and that it is absent
// entirely unless `badge: true` was set.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { github } from '../src/deps.js';
import {
  testCountsFor,
  testTableRows,
  floorPercent,
  buildBadgePayload,
  withBadge,
  coverageBadgePayload,
  analysisBadgePayload,
  buildCoverageComment,
  coverageSummary,
} from '../src/index.js';

const WORKSPACE = '/repo';

function coverageReport(overrides = {}) {
  return {
    summary: {
      totalLines: 200,
      coveredLines: 199,
      percent: 99.5,
      minimumRequiredPercent: 100,
      hasMetThreshold: false,
      minimumRequiredPercentSource: 'config',
      ...(overrides.summary || {}),
    },
    testResults: overrides.testResults || [
      { project: 'A.Tests', exitCode: 0, succeeded: true, total: 10, passed: 9, failed: 0, skipped: 1 },
    ],
    uncoveredRegions: overrides.uncoveredRegions || [],
  };
}

// ---------------------------------------------------------------------------
// testCountsFor
// ---------------------------------------------------------------------------

test('testCountsFor: sums the counts across projects', () => {
  const counts = testCountsFor([
    { project: 'A', total: 10, passed: 9, failed: 0, skipped: 1 },
    { project: 'B', total: 5, passed: 4, failed: 1, skipped: 0 },
  ]);
  assert.deepEqual(counts, { total: 15, passed: 13, failed: 1, skipped: 1 });
});

test('testCountsFor: a report from an older CLI (no count fields) yields null', () => {
  assert.equal(testCountsFor([{ project: 'A.Tests', exitCode: 0, succeeded: true }]), null);
  assert.equal(testCountsFor([]), null);
  assert.equal(testCountsFor(undefined), null);
});

test('testCountsFor: sums only the projects that report counts', () => {
  const counts = testCountsFor([
    { project: 'A', exitCode: 0, succeeded: true },
    { project: 'B', total: 5, passed: 5, failed: 0, skipped: 0 },
    null,
    'not-an-object',
  ]);
  assert.deepEqual(counts, { total: 5, passed: 5, failed: 0, skipped: 0 });
});

test('testCountsFor: null and non-numeric fields do not poison the sum', () => {
  const counts = testCountsFor([
    { project: 'A', total: 4, passed: null, failed: 0, skipped: undefined },
    { project: 'B', total: 'many', passed: 3, failed: 0, skipped: 0 },
  ]);
  assert.deepEqual(counts, { total: 4, passed: 3, failed: 0, skipped: 0 });
});

// ---------------------------------------------------------------------------
// floorPercent
// ---------------------------------------------------------------------------

test('floorPercent: truncates to two decimals and never rounds up to 100', () => {
  assert.equal(floorPercent(99.999), 99.99);
  assert.equal(floorPercent(98.33), 98.33, 'binary-float error must not shave a clean value');
  assert.equal(floorPercent(100), 100);
  assert.equal(floorPercent(0), 0);
});

// ---------------------------------------------------------------------------
// the payload shape
// ---------------------------------------------------------------------------

let savedPayload;
let savedRefName;

beforeEach(() => {
  savedPayload = github.context.payload;
  savedRefName = process.env.GITHUB_REF_NAME;
  github.context.payload = { repository: { default_branch: 'main' } };
  process.env.GITHUB_REF_NAME = 'main';
});

afterEach(() => {
  github.context.payload = savedPayload;
  if (savedRefName === undefined) delete process.env.GITHUB_REF_NAME;
  else process.env.GITHUB_REF_NAME = savedRefName;
});

test('buildBadgePayload: unknown fields stay null', () => {
  assert.deepEqual(buildBadgePayload(), {
    branch: 'main',
    isDefaultBranch: true,
    coverage: null,
    findings: null,
    testCounts: null,
  });
});

test('buildBadgePayload: a feature branch is not the default branch', () => {
  process.env.GITHUB_REF_NAME = 'feat/x';
  assert.equal(buildBadgePayload().isDefaultBranch, false);
});

test('buildBadgePayload: an unknown branch or default branch is never "default"', () => {
  delete process.env.GITHUB_REF_NAME;
  assert.deepEqual(
    { branch: buildBadgePayload().branch, isDefault: buildBadgePayload().isDefaultBranch },
    { branch: '', isDefault: false }
  );

  process.env.GITHUB_REF_NAME = 'main';
  github.context.payload = {};
  assert.equal(buildBadgePayload().isDefaultBranch, false);
});

test('coverageBadgePayload: carries the displayed percent and the line totals', () => {
  const badge = coverageBadgePayload(coverageSummary(coverageReport()));
  assert.deepEqual(badge, {
    branch: 'main',
    isDefaultBranch: true,
    coverage: { percent: 99.5, requiredPercent: 100, met: false, coveredLines: 199, measurableLines: 200 },
    findings: null,
    testCounts: { total: 10, passed: 9, failed: 0, skipped: 1 },
  });
});

test('coverageBadgePayload: a run without data reports no coverage and no counts', () => {
  const badge = coverageBadgePayload(coverageSummary({}));
  assert.equal(badge.coverage, null);
  assert.equal(badge.testCounts, null);
});

test('coverageBadgePayload: an older CLI report still carries coverage, without counts', () => {
  const badge = coverageBadgePayload(
    coverageSummary(coverageReport({ testResults: [{ project: 'A.Tests', exitCode: 0, succeeded: true }] }))
  );
  assert.equal(badge.coverage.percent, 99.5);
  assert.equal(badge.testCounts, null);
});

test('analysisBadgePayload: carries the finding counts by severity', () => {
  const badge = analysisBadgePayload({ total: 6, error: 1, warn: 2, info: 3 });
  assert.deepEqual(badge.findings, { errors: 1, warnings: 2, infos: 3 });
  assert.equal(badge.coverage, null);
  assert.equal(badge.testCounts, null);
});

test('withBadge: omits the property entirely without the opt-in', () => {
  const base = { checkName: 'CodeCharter' };
  let built = 0;
  const badge = () => {
    built++;
    return { branch: 'main' };
  };

  const without = withBadge(base, false, badge);
  assert.equal('badge' in without, false, 'the property must be absent, not null');
  assert.equal(built, 0, 'no numbers are even computed without the opt-in');

  const withIt = withBadge(base, true, badge);
  assert.deepEqual(withIt, { checkName: 'CodeCharter', badge: { branch: 'main' } });
  assert.equal('badge' in base, false, 'the original payload is not mutated');
});

// ---------------------------------------------------------------------------
// the summary table
// ---------------------------------------------------------------------------

test('testTableRows: renders one row per project plus a totals row', () => {
  assert.deepEqual(
    testTableRows([{ project: 'A.Tests', exitCode: 0, succeeded: true, total: 3, passed: 2, failed: 1, skipped: 0 }], {
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

test('buildCoverageComment: shows the test counts when the report has them', () => {
  const md = buildCoverageComment(coverageSummary(coverageReport()), WORKSPACE, {
    repoFull: 'acme/app',
    sha: 'abc',
    failOnThreshold: true,
    exitCode: 1,
  });
  assert.match(md, /\| Project \| Result \| Tests \| Passed \| Failed \| Skipped \|/);
  assert.match(md, /\| A\.Tests \| ✅ \| 10 \| 9 \| 0 \| 1 \|/);
  assert.match(md, /\| \*\*Σ 1 project\*\* \| ✅ \| \*\*10\*\* \| \*\*9\*\* \| \*\*0\*\* \| \*\*1\*\* \|/);
});

test('buildCoverageComment: an older CLI report still gets a row, with em-dashes for counts', () => {
  const md = buildCoverageComment(
    coverageSummary(coverageReport({ testResults: [{ project: 'A.Tests', exitCode: 0, succeeded: true }] })),
    WORKSPACE,
    { repoFull: 'acme/app', sha: 'abc', failOnThreshold: true, exitCode: 1 }
  );
  assert.match(md, /\| A\.Tests \| ✅ \| — \| — \| — \| — \|/);
  assert.match(md, /\| \*\*Σ 1 project\*\* \| ✅ \| — \| — \| — \| — \|/);
});
