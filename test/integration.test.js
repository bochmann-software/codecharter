'use strict';

// Integration coverage for the orchestrator. Two angles:
//   1. In-process: drive run() through its input-parsing and auto-discovery path
//      to a graceful early failure (no network, no CLI).
//   2. Built bundle: spawn the real dist/index.js and assert it fails cleanly on
//      a missing required input, proving the entry-point guard works.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { core } from '../src/deps.js';
import { run } from '../src/index.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

// --- 1. in-process orchestrator -------------------------------------------

let saved;
let emptyWorkspace;

beforeEach(() => {
  emptyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-empty-'));
  saved = {
    setFailed: core.setFailed,
    setOutput: core.setOutput,
    warning: core.warning,
    info: core.info,
    setSecret: core.setSecret,
    env: { ...process.env },
  };
  core.setOutput = () => {};
  core.warning = () => {};
  core.info = () => {};
  // Clear any INPUT_* the host may have set, then provide a deterministic set.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) delete process.env[key];
  }
  process.env.GITHUB_WORKSPACE = emptyWorkspace;
});

afterEach(() => {
  core.setFailed = saved.setFailed;
  core.setOutput = saved.setOutput;
  core.warning = saved.warning;
  core.info = saved.info;
  core.setSecret = saved.setSecret;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_') || key === 'GITHUB_WORKSPACE') delete process.env[key];
  }
  Object.assign(process.env, saved.env);
  fs.rmSync(emptyWorkspace, { recursive: true, force: true });
});

test('run(): with no solution and an empty workspace, fails before any network call', async () => {
  process.env['INPUT_API-KEY'] = 'dummy-key';
  let failure;
  core.setFailed = (m) => {
    failure = m;
  };
  let secreted;
  core.setSecret = (v) => {
    secreted = v;
  };

  await run();

  assert.equal(secreted, 'dummy-key', 'the api-key is registered as a secret');
  assert.match(failure, /No `solution` input was given and no .*\.sln.*found/);
});

// --- 2. built bundle smoke test -------------------------------------------

// Spawning a child under `--experimental-test-coverage` breaks the parent's V8
// coverage aggregation (a bundled source map has no sourcesContent). The plain
// `npm test` CI step runs this; the coverage step skips it.
test(
  'dist bundle: running it with no api-key fails with the required-input error',
  { skip: process.env.NODE_V8_COVERAGE ? 'spawning breaks coverage aggregation' : false },
  () => {
    const env = { ...process.env };
    delete env['INPUT_API-KEY']; // the only required input
    // Don't let the child emit V8 coverage into the parent's collection dir: the
    // bundled dist has a source map without sourcesContent, which breaks the
    // parent's coverage report aggregation.
    delete env.NODE_V8_COVERAGE;

    const result = spawnSync(process.execPath, ['dist/index.js'], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
    });

    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /Input required and not supplied: api-key/);
  }
);
