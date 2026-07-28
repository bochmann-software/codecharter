'use strict';

// The coverage-mode helpers: flattening the CLI's JSON report, rendering the
// comment, and mapping the exit code to a verdict. These carry the gate logic,
// so every branch (met, below, no data, tests failed, environment error) is
// exercised here rather than through a full action run.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  coverageSummary,
  buildCoverageComment,
  coverageFooterLine,
  coverageConclusion,
  coverageTitle,
  MAX_COMMENT_ROWS,
} from '../src/index.js';

const WORKSPACE = '/repo';

function report(overrides = {}) {
  return {
    summary: {
      totalLines: 120,
      coveredLines: 118,
      percent: 98.33,
      minimumRequiredPercent: 100,
      hasMetThreshold: false,
      minimumRequiredPercentSource: 'config',
      ...(overrides.summary || {}),
    },
    testResults: overrides.testResults || [{ project: 'MyApp.Tests', exitCode: 0, succeeded: true }],
    uncoveredRegions: overrides.uncoveredRegions || [
      {
        file: '/repo/src/MyApp/Service.cs',
        relativeFile: 'src/MyApp/Service.cs',
        method: 'Handle',
        lines: [42, 43],
        snippet: '...',
      },
    ],
  };
}

test('coverageSummary flattens the report', () => {
  const s = coverageSummary(report());
  assert.equal(s.total, 120);
  assert.equal(s.covered, 118);
  assert.equal(s.percent, 98.33);
  assert.equal(s.required, 100);
  assert.equal(s.source, 'config');
  assert.equal(s.met, false);
  assert.equal(s.regions.length, 1);
  assert.equal(s.projects.length, 1);
});

test('coverageSummary treats a missing or malformed report as nothing measured', () => {
  for (const input of [null, undefined, {}, { summary: null }]) {
    const s = coverageSummary(input);
    assert.equal(s.total, 0);
    assert.equal(s.covered, 0);
    assert.equal(s.percent, null);
    assert.equal(s.required, null);
    assert.equal(s.met, false, 'a malformed report must never read as a passing gate');
    assert.deepEqual(s.regions, []);
  }
});

test('coverageSummary only reports met when the CLI said so', () => {
  const s = coverageSummary(report({ summary: { hasMetThreshold: true, percent: 100 } }));
  assert.equal(s.met, true);
});

test('buildCoverageComment renders badges, the region table and a blocking footer', () => {
  const s = coverageSummary(report());
  const md = buildCoverageComment(s, WORKSPACE, {
    repoFull: 'acme/app',
    sha: 'abc123',
    titleSuffix: 'src',
    failOnThreshold: true,
    exitCode: 1,
  });

  assert.match(md, /^## CodeCharter Coverage — `src`/);
  assert.match(md, /badge\/coverage-98\.33%25-red/);
  assert.match(md, /badge\/required-100%25-blue/);
  assert.match(md, /118 of 120 measurable lines covered \(threshold from `config`\)/);
  assert.match(md, /<summary>src\/MyApp\/Service\.cs \(1 uncovered region\(s\)\)<\/summary>/);
  assert.match(md, /\| 42-43 \| Handle \| \[src\/MyApp\/Service\.cs:42\]/);
  assert.match(md, /https:\/\/github\.com\/acme\/app\/blob\/abc123\/src\/MyApp\/Service\.cs#L42/);
  assert.match(md, /Cover the regions above before merging/);
});

test('buildCoverageComment shows a green badge and no blocking footer when the gate passed', () => {
  const s = coverageSummary(report({ summary: { percent: 100, hasMetThreshold: true }, uncoveredRegions: [] }));
  const md = buildCoverageComment(s, WORKSPACE, {
    repoFull: 'acme/app',
    sha: 'abc',
    failOnThreshold: true,
    exitCode: 0,
  });

  assert.match(md, /badge\/coverage-100\.00%25-brightgreen/);
  assert.match(md, /Coverage meets the required minimum/);
  assert.doesNotMatch(md, /<details>/);
});

test('buildCoverageComment reports no-data runs without a percentage', () => {
  const s = coverageSummary({});
  const md = buildCoverageComment(s, WORKSPACE, {
    repoFull: 'acme/app',
    sha: 'abc',
    failOnThreshold: true,
    exitCode: 3,
  });

  assert.match(md, /coverage-no%20data-lightgrey/);
  assert.match(md, /No coverage data was produced/);
  assert.doesNotMatch(md, /measurable lines covered/);
});

test('buildCoverageComment renders a single-line region without a span', () => {
  const s = coverageSummary(report({ uncoveredRegions: [{ relativeFile: 'src/A.cs', method: 'M', lines: [7] }] }));
  const md = buildCoverageComment(s, WORKSPACE, {
    repoFull: 'acme/app',
    sha: 'abc',
    failOnThreshold: true,
    exitCode: 1,
  });
  assert.match(md, /\| 7 \| M \|/);
});

test('buildCoverageComment escapes pipes and backslashes in method names', () => {
  const s = coverageSummary(report({ uncoveredRegions: [{ relativeFile: 'src/A.cs', method: 'A|B\\C', lines: [1] }] }));
  const md = buildCoverageComment(s, WORKSPACE, {
    repoFull: 'acme/app',
    sha: 'abc',
    failOnThreshold: true,
    exitCode: 1,
  });
  assert.match(md, /A\\\|B\\\\C/);
});

test('buildCoverageComment falls back to a plain location without repo context', () => {
  const s = coverageSummary(report());
  const md = buildCoverageComment(s, WORKSPACE, { repoFull: '', sha: '', failOnThreshold: true, exitCode: 1 });
  assert.match(md, /\| src\/MyApp\/Service\.cs:42 \|/);
  assert.doesNotMatch(md, /https:\/\/github\.com/);
});

test('buildCoverageComment truncates very long region lists', () => {
  const regions = Array.from({ length: MAX_COMMENT_ROWS + 5 }, (_, i) => ({
    relativeFile: `src/File${String(i).padStart(3, '0')}.cs`,
    method: 'M',
    lines: [i + 1],
  }));
  const s = coverageSummary(report({ uncoveredRegions: regions }));
  const md = buildCoverageComment(s, WORKSPACE, {
    repoFull: 'acme/app',
    sha: 'abc',
    failOnThreshold: true,
    exitCode: 1,
  });

  assert.match(md, new RegExp(`Showing the first ${MAX_COMMENT_ROWS} uncovered regions`));
});

test('coverageFooterLine states when the gate does not block', () => {
  const s = coverageSummary(report());
  assert.match(coverageFooterLine(s, false), /not failing the check/);
  assert.match(coverageFooterLine(s, true), /before merging/);
});

test('coverageConclusion maps exit codes', () => {
  assert.equal(coverageConclusion(0, true), 'success');
  assert.equal(coverageConclusion(1, true), 'failure');
  assert.equal(coverageConclusion(1, false), 'neutral', 'a non-blocking run must not report failure');
  assert.equal(coverageConclusion(2, true), 'failure');
  assert.equal(coverageConclusion(3, true), 'failure');
  assert.equal(coverageConclusion(64, false), 'failure', 'an environment error fails regardless of the gate input');
});

test('coverageTitle names the outcome', () => {
  const below = coverageSummary(report());
  const met = coverageSummary(report({ summary: { percent: 100, hasMetThreshold: true } }));

  assert.equal(coverageTitle(0, met), 'Coverage 100.00%');
  assert.equal(coverageTitle(1, below), 'Coverage 98.33% is below the required minimum');
  assert.equal(coverageTitle(2, below), 'Tests failed or coverage was incomplete');
  assert.equal(coverageTitle(3, coverageSummary({})), 'No coverage data');
  assert.equal(coverageTitle(64, below), 'Coverage could not run (usage, config, or environment error)');
});
