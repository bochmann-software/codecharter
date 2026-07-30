'use strict';

// The opt-in badge payload: the aggregate numbers the portal needs to serve
// repository badges. Two things matter and are pinned here: the exact shape of
// the object (the portal is built against this contract), and that it is absent
// entirely unless `badge: true` was set.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { core, exec, github, io, tc, cache, HttpClient } from '../src/deps.js';
import {
  testCountsFor,
  testCountRows,
  floorPercent,
  buildBadgePayload,
  withBadge,
  coverageBadgePayload,
  analysisBadgePayload,
  buildCoverageComment,
  coverageSummary,
  runCoverage,
  run,
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

test('testCountRows: renders a table, or nothing at all without counts', () => {
  assert.deepEqual(testCountRows(null), []);
  assert.deepEqual(testCountRows({ total: 3, passed: 2, failed: 1, skipped: 0 }), [
    '| Tests | Passed | Failed | Skipped |',
    '|-------|--------|--------|---------|',
    '| 3 | 2 | 1 | 0 |',
    '',
  ]);
});

test('buildCoverageComment: shows the test counts when the report has them', () => {
  const md = buildCoverageComment(coverageSummary(coverageReport()), WORKSPACE, {
    repoFull: 'acme/app',
    sha: 'abc',
    failOnThreshold: true,
    exitCode: 1,
  });
  assert.match(md, /\| Tests \| Passed \| Failed \| Skipped \|/);
  assert.match(md, /\| 10 \| 9 \| 0 \| 1 \|/);
});

test('buildCoverageComment: omits the test-count table for an older CLI report', () => {
  const md = buildCoverageComment(
    coverageSummary(coverageReport({ testResults: [{ project: 'A.Tests', exitCode: 0, succeeded: true }] })),
    WORKSPACE,
    { repoFull: 'acme/app', sha: 'abc', failOnThreshold: true, exitCode: 1 }
  );
  assert.doesNotMatch(md, /\| Tests \| Passed \|/);
});

// ---------------------------------------------------------------------------
// wiring: coverage mode
// ---------------------------------------------------------------------------

let savedForRun;
let posts;
let tmp;

function stubCommonToolkit() {
  savedForRun = {
    info: core.info,
    warning: core.warning,
    debug: core.debug,
    setOutput: core.setOutput,
    setFailed: core.setFailed,
    setSecret: core.setSecret,
    summary: core.summary,
    exec: exec.exec,
    which: io.which,
    rmRF: io.rmRF,
    mkdirP: io.mkdirP,
    extractTar: tc.extractTar,
    extractZip: tc.extractZip,
    isFeatureAvailable: cache.isFeatureAvailable,
    post: HttpClient.prototype.post,
    get: HttpClient.prototype.get,
    env: { ...process.env },
  };
  core.info = () => {};
  core.warning = () => {};
  core.debug = () => {};
  core.setOutput = () => {};
  core.setFailed = () => {};
  core.setSecret = () => {};
  Object.defineProperty(core, 'summary', {
    configurable: true,
    writable: true,
    value: {
      addRaw() {
        return this;
      },
      async write() {
        return this;
      },
    },
  });
  io.which = async () => '';
  process.env.GITHUB_REPOSITORY = 'acme/app';
  posts = [];
  HttpClient.prototype.post = async (url, body) => {
    posts.push(JSON.parse(body));
    return { message: { statusCode: 200 }, readBody: async () => '' };
  };
}

function restoreCommonToolkit() {
  core.info = savedForRun.info;
  core.warning = savedForRun.warning;
  core.debug = savedForRun.debug;
  core.setOutput = savedForRun.setOutput;
  core.setFailed = savedForRun.setFailed;
  core.setSecret = savedForRun.setSecret;
  Object.defineProperty(core, 'summary', { value: savedForRun.summary, configurable: true, writable: true });
  exec.exec = savedForRun.exec;
  io.which = savedForRun.which;
  io.rmRF = savedForRun.rmRF;
  io.mkdirP = savedForRun.mkdirP;
  tc.extractTar = savedForRun.extractTar;
  tc.extractZip = savedForRun.extractZip;
  cache.isFeatureAvailable = savedForRun.isFeatureAvailable;
  HttpClient.prototype.post = savedForRun.post;
  HttpClient.prototype.get = savedForRun.get;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_') || key.startsWith('GITHUB_')) delete process.env[key];
  }
  Object.assign(process.env, savedForRun.env);
}

// Runs coverage mode against a stubbed CLI that writes the given report.
async function coverageRun(report, options) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-badge-'));
  exec.exec = async (_exe, args) => {
    const out = args[args.indexOf('--output-file') + 1];
    fs.writeFileSync(out, JSON.stringify(report));
    return 1;
  };
  try {
    await runCoverage({
      exe: 'codecharter',
      env: {},
      workspace: tmp,
      tmp,
      portal: 'https://portal',
      apiKey: 'KEY',
      options: {
        root: '',
        failOnThreshold: false,
        wantComment: false,
        githubToken: '',
        ...options,
      },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return posts[0];
}

test('coverage mode: no badge property is posted by default', async () => {
  stubCommonToolkit();
  try {
    const payload = await coverageRun(coverageReport(), { badge: false });
    assert.equal('badge' in payload, false, 'the property must be absent, not null');
  } finally {
    restoreCommonToolkit();
  }
});

test('coverage mode: badge: true attaches the coverage numbers and test counts', async () => {
  stubCommonToolkit();
  process.env.GITHUB_REF_NAME = 'main';
  github.context.payload = { repository: { default_branch: 'main' } };
  try {
    const payload = await coverageRun(coverageReport(), { badge: true });
    assert.deepEqual(payload.badge, {
      branch: 'main',
      isDefaultBranch: true,
      coverage: { percent: 99.5, requiredPercent: 100, met: false, coveredLines: 199, measurableLines: 200 },
      findings: null,
      testCounts: { total: 10, passed: 9, failed: 0, skipped: 1 },
    });
  } finally {
    restoreCommonToolkit();
  }
});

// ---------------------------------------------------------------------------
// wiring: analyze mode
// ---------------------------------------------------------------------------

// Drives run() in analyze mode against a stubbed download/extract/CLI, and
// returns the payload posted to the portal.
async function analyzeRun(inputs) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-badge-ws-'));
  fs.writeFileSync(path.join(workspace, 'App.sln'), '');
  fs.mkdirSync(path.join(workspace, 'rules'));
  process.env.GITHUB_WORKSPACE = workspace;
  process.env['INPUT_API-KEY'] = 'KEY';
  process.env.INPUT_CACHE = 'false';
  for (const [key, value] of Object.entries(inputs)) process.env[key] = value;

  cache.isFeatureAvailable = () => false;
  // The download writes the response stream to disk, so it must be a real
  // readable carrying the status code and headers the download path reads.
  HttpClient.prototype.get = async () => {
    const stream = Readable.from(['archive']);
    stream.statusCode = 200;
    stream.headers = {};
    return { message: stream, readBody: async () => '' };
  };
  const extract = async (_archive, dir) => {
    fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'codecharter.exe' : 'codecharter'), '');
    return dir;
  };
  tc.extractTar = extract;
  tc.extractZip = extract;
  exec.exec = async (_exe, args) => {
    const jsonArg = args.find((a) => typeof a === 'string' && a.startsWith('json:'));
    fs.writeFileSync(jsonArg.slice('json:'.length), JSON.stringify({ violations: [{ severity: 'error' }] }));
    return 0;
  };

  try {
    await run();
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  return posts[0];
}

test('analyze mode: no badge property is posted by default', async () => {
  stubCommonToolkit();
  try {
    const payload = await analyzeRun({});
    assert.equal('badge' in payload, false);
  } finally {
    restoreCommonToolkit();
  }
});

test('analyze mode: badge: true attaches the finding counts', async () => {
  stubCommonToolkit();
  try {
    github.context.payload = { repository: { default_branch: 'main' } };
    const payload = await analyzeRun({ INPUT_BADGE: 'true', GITHUB_REF_NAME: 'main' });
    assert.deepEqual(payload.badge, {
      branch: 'main',
      isDefaultBranch: true,
      coverage: null,
      findings: { errors: 1, warnings: 0, infos: 0 },
      testCounts: null,
    });
  } finally {
    restoreCommonToolkit();
  }
});
