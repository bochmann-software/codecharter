'use strict';

// End-to-end wiring of the two publish paths, with the toolkit (download,
// extract, exec, portal, comment) stubbed and a real temp workspace: which
// payload reaches the portal, whether the opt-in badge rides along, and how the
// CLI's exit code becomes the step verdict. The pure helpers behind these paths
// are unit-tested in badge.test.js and coverage.test.js.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { core, exec, github, io, tc, cache, HttpClient } from '../src/deps.js';
import { run, runCoverage } from '../src/index.js';

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

let saved;
let posts;
let failures;
let warnings;
let outputs;
let postStatus;

beforeEach(() => {
  saved = {
    info: core.info,
    warning: core.warning,
    debug: core.debug,
    setOutput: core.setOutput,
    setFailed: core.setFailed,
    setSecret: core.setSecret,
    summary: core.summary,
    exec: exec.exec,
    which: io.which,
    extractTar: tc.extractTar,
    extractZip: tc.extractZip,
    isFeatureAvailable: cache.isFeatureAvailable,
    post: HttpClient.prototype.post,
    get: HttpClient.prototype.get,
    payload: github.context.payload,
    env: { ...process.env },
  };

  failures = [];
  warnings = [];
  outputs = {};
  posts = [];
  postStatus = 200;

  core.info = () => {};
  core.debug = () => {};
  core.setSecret = () => {};
  core.warning = (m) => warnings.push(m);
  core.setFailed = (m) => failures.push(m);
  core.setOutput = (name, value) => {
    outputs[name] = value;
  };
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
  HttpClient.prototype.post = async (url, body) => {
    posts.push({ url, body: JSON.parse(body) });
    return { message: { statusCode: postStatus }, readBody: async () => '' };
  };

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) delete process.env[key];
  }
  process.env.GITHUB_REPOSITORY = 'acme/app';
  process.env.GITHUB_REF_NAME = 'main';
  github.context.payload = { repository: { default_branch: 'main' } };
});

afterEach(() => {
  core.info = saved.info;
  core.warning = saved.warning;
  core.debug = saved.debug;
  core.setOutput = saved.setOutput;
  core.setFailed = saved.setFailed;
  core.setSecret = saved.setSecret;
  Object.defineProperty(core, 'summary', { value: saved.summary, configurable: true, writable: true });
  exec.exec = saved.exec;
  io.which = saved.which;
  tc.extractTar = saved.extractTar;
  tc.extractZip = saved.extractZip;
  cache.isFeatureAvailable = saved.isFeatureAvailable;
  HttpClient.prototype.post = saved.post;
  HttpClient.prototype.get = saved.get;
  github.context.payload = saved.payload;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_') || key.startsWith('GITHUB_')) delete process.env[key];
  }
  Object.assign(process.env, saved.env);
});

// ---------------------------------------------------------------------------
// coverage mode
// ---------------------------------------------------------------------------

// Runs coverage mode against a stubbed CLI that writes the given report and
// exits with the given code. Returns the payload posted to the portal.
async function coverageRun(report, options = {}, exitCode = 1) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wiring-'));
  exec.exec = async (_exe, args) => {
    if (report) fs.writeFileSync(args[args.indexOf('--output-file') + 1], JSON.stringify(report));
    return exitCode;
  };
  try {
    await runCoverage({
      exe: 'codecharter',
      env: {},
      workspace: tmp,
      tmp,
      portal: 'https://portal',
      apiKey: 'KEY',
      options: { root: '', failOnThreshold: false, wantComment: false, githubToken: '', ...options },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return posts[0]?.body;
}

test('coverage mode: posts the check payload without a badge by default', async () => {
  const payload = await coverageRun(coverageReport(), { badge: false });
  assert.equal(posts[0].url, 'https://portal/api/v1/ci/checks');
  assert.equal(payload.checkName, 'CodeCharter Coverage');
  assert.equal('badge' in payload, false, 'the property must be absent, not null');
  assert.equal(outputs['coverage-percent'], 99.5);
  assert.equal(outputs['coverage-met'], 'false');
});

test('coverage mode: badge: true attaches the coverage numbers and test counts', async () => {
  const payload = await coverageRun(coverageReport(), { badge: true });
  assert.deepEqual(payload.badge, {
    branch: 'main',
    isDefaultBranch: true,
    coverage: { percent: 99.5, requiredPercent: 100, met: false, coveredLines: 199, measurableLines: 200 },
    findings: null,
    testCounts: { total: 10, passed: 9, failed: 0, skipped: 1 },
  });
});

test('coverage mode: the badge follows the requested report path and CLI arguments', async () => {
  const payload = await coverageRun(coverageReport(), {
    badge: true,
    root: 'src',
    minCoverage: '95',
    skipTests: true,
    resultsRoot: 'artifacts',
    reportOutput: 'coverage.json',
    commentKey: 'gate',
  });
  assert.equal(payload.checkName, 'CodeCharter Coverage / gate');
  assert.ok(outputs['coverage-report-path'].endsWith('coverage.json'));
  assert.equal(payload.badge.coverage.percent, 99.5);
});

test('coverage mode: a met gate succeeds and fails nothing', async () => {
  const payload = await coverageRun(
    coverageReport({ summary: { percent: 100, coveredLines: 200, hasMetThreshold: true } }),
    { badge: true },
    0
  );
  assert.equal(payload.conclusion, 'success');
  assert.equal(payload.badge.coverage.met, true);
  assert.deepEqual(failures, []);
});

test('coverage mode: a blocking gate fails the step with an actionable message', async () => {
  await coverageRun(coverageReport(), { failOnThreshold: true }, 1);
  assert.match(failures[0], /Coverage is 99\.50%, below the required 100%/);
  assert.match(failures[0], /cover the regions listed above/);
});

test('coverage mode: failing tests, missing data and startup errors always fail', async () => {
  await coverageRun(coverageReport(), {}, 2);
  assert.match(failures[0], /tests failed or the coverage data was incomplete/);

  failures.length = 0;
  posts.length = 0;
  await coverageRun(null, {}, 3);
  assert.match(failures[0], /produced no coverage data/);

  failures.length = 0;
  posts.length = 0;
  await coverageRun(null, {}, 64);
  assert.match(failures[0], /could not start \(exit code 64\)/);
});

test('coverage mode: a terminated process is reported as such', async () => {
  await coverageRun(null, {}, null);
  assert.match(failures[0], /exit code null \(process terminated\)/);
});

test('coverage mode: warns when no .NET SDK is on the runner', async () => {
  const savedRoot = process.env.DOTNET_ROOT;
  delete process.env.DOTNET_ROOT;
  try {
    await coverageRun(coverageReport(), {}, 0);
    assert.ok(warnings.some((m) => /No \.NET SDK detected/.test(m)));
  } finally {
    if (savedRoot !== undefined) process.env.DOTNET_ROOT = savedRoot;
  }
});

test('coverage mode: falls back to the workflow-token comment when the portal declines', async () => {
  postStatus = 404;
  await coverageRun(coverageReport(), { wantComment: true, githubToken: '' }, 0);
  assert.ok(warnings.some((m) => /No github-token available/.test(m)));
});

// ---------------------------------------------------------------------------
// analyze mode
// ---------------------------------------------------------------------------

// Drives run() in analyze mode against a stubbed download/extract/CLI, and
// returns the payload posted to the portal.
async function analyzeRun(inputs = {}, { violations = [{ severity: 'error' }], exitCode = 0 } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wiring-ws-'));
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
    fs.writeFileSync(jsonArg.slice('json:'.length), JSON.stringify({ violations }));
    return exitCode;
  };

  try {
    await run();
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  return posts[0]?.body;
}

test('analyze mode: posts the check payload without a badge by default', async () => {
  const payload = await analyzeRun();
  assert.equal('badge' in payload, false);
  assert.equal(outputs['findings-total'], 1);
  assert.equal(outputs['findings-error'], 1);
});

test('analyze mode: badge: true attaches the finding counts', async () => {
  const payload = await analyzeRun({ INPUT_BADGE: 'true' });
  assert.deepEqual(payload.badge, {
    branch: 'main',
    isDefaultBranch: true,
    coverage: null,
    findings: { errors: 1, warnings: 0, infos: 0 },
    testCounts: null,
  });
});

test('analyze mode: the badge counts every severity, on a feature branch', async () => {
  process.env.GITHUB_REF_NAME = 'feat/x';
  const payload = await analyzeRun(
    { INPUT_BADGE: 'true', 'INPUT_SARIF-OUTPUT': 'results.sarif', 'INPUT_COMMENT-KEY': 'main-sln' },
    { violations: [{ severity: 'error' }, { severity: 'warning' }, { severity: 'info' }, { severity: 'hint' }] }
  );
  assert.deepEqual(payload.badge.findings, { errors: 1, warnings: 1, infos: 2 });
  assert.equal(payload.badge.isDefaultBranch, false);
  assert.equal(payload.checkName, 'CodeCharter / main-sln');
  assert.ok(outputs['sarif-path'].endsWith('results.sarif'));
});

test('analyze mode: the badge is still attached when the fail-on gate trips', async () => {
  const payload = await analyzeRun({ INPUT_BADGE: 'true' }, { exitCode: 1 });
  assert.equal(payload.conclusion, 'failure');
  assert.deepEqual(payload.badge.findings, { errors: 1, warnings: 0, infos: 0 });
  assert.match(failures[0], /`fail-on: error` gate failed the build/);
});

test('analyze mode: fail-on never reports the findings without failing', async () => {
  const payload = await analyzeRun({ INPUT_BADGE: 'true', 'INPUT_FAIL-ON': 'never' }, { exitCode: 1 });
  assert.equal(payload.conclusion, 'neutral');
  assert.deepEqual(failures, []);
});

test('analyze mode: an unknown mode fails before anything runs', async () => {
  process.env['INPUT_API-KEY'] = 'KEY';
  process.env.INPUT_MODE = 'lint';
  await run();
  assert.match(failures[0], /Unknown `mode`: "lint"/);
  assert.deepEqual(posts, []);
});
