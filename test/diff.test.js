'use strict';

// resolveDiffArgs turns the single `diff` input into CLI args. It branches on
// reserved keywords, file-vs-range interpretation and git success/failure, and
// reports problems through @actions/core. The action and these tests import the
// toolkit from the same src/deps.js wrappers, so overriding methods on core/exec/
// github intercepts exactly the calls resolveDiffArgs makes.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { core, exec, github } from '../src/deps.js';
import { resolveDiffArgs } from '../src/index.js';

let warnings;
let failures;
let saved;
let tmp;
let workspace;

beforeEach(() => {
  warnings = [];
  failures = [];
  saved = {
    warning: core.warning,
    setFailed: core.setFailed,
    info: core.info,
    execExec: exec.exec,
    payload: github.context.payload,
  };
  core.warning = (m) => warnings.push(m);
  core.setFailed = (m) => failures.push(m);
  core.info = () => {};
  github.context.payload = {};
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-diff-test-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-test-'));
});

afterEach(() => {
  core.warning = saved.warning;
  core.setFailed = saved.setFailed;
  core.info = saved.info;
  exec.exec = saved.execExec;
  github.context.payload = saved.payload;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('resolveDiffArgs: empty and "false" (any case) → no diff args', async () => {
  assert.deepEqual(await resolveDiffArgs('', workspace, tmp), []);
  assert.deepEqual(await resolveDiffArgs('   ', workspace, tmp), []);
  assert.deepEqual(await resolveDiffArgs('false', workspace, tmp), []);
  assert.deepEqual(await resolveDiffArgs('FALSE', workspace, tmp), []);
});

test('resolveDiffArgs: "true" off a pull_request event warns and disables diff', async () => {
  github.context.payload = {}; // not a PR
  const result = await resolveDiffArgs('true', workspace, tmp);
  assert.deepEqual(result, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /only scopes analysis on pull_request events/);
});

test('resolveDiffArgs: an existing file is used as-is, even when its name has ".."', async () => {
  const diffFile = path.join(workspace, 'weird..name.diff');
  fs.writeFileSync(diffFile, 'patch');
  const result = await resolveDiffArgs('weird..name.diff', workspace, tmp);
  assert.deepEqual(result, ['--diff', path.resolve(workspace, 'weird..name.diff')]);
});

test('resolveDiffArgs: invalid value (no "..", not a file) fails with guidance', async () => {
  const result = await resolveDiffArgs('not-a-range', workspace, tmp);
  assert.equal(result, null);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Invalid `diff` input "not-a-range"/);
});

test('resolveDiffArgs: a ref range runs git diff and writes the captured patch', async () => {
  let calledArgs;
  exec.exec = async (cmd, args, opts) => {
    calledArgs = { cmd, args };
    opts.listeners.stdout(Buffer.from('diff --git a b\n'));
    return 0;
  };
  const result = await resolveDiffArgs('main..HEAD', workspace, tmp);
  const expected = path.join(tmp, 'codecharter.diff');
  assert.deepEqual(result, ['--diff', expected]);
  assert.equal(fs.readFileSync(expected, 'utf8'), 'diff --git a b\n');
  assert.equal(calledArgs.cmd, 'git');
  assert.ok(calledArgs.args.includes('main..HEAD'));
  assert.ok(calledArgs.args.includes('--unified=0'));
  assert.equal(warnings.length, 0);
});

test('resolveDiffArgs: an empty diff still returns args but warns nothing is analyzed', async () => {
  exec.exec = async () => 0; // no stdout → empty diff
  const result = await resolveDiffArgs('main..HEAD', workspace, tmp);
  assert.deepEqual(result, ['--diff', path.join(tmp, 'codecharter.diff')]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /resolved diff is empty/);
});

test('resolveDiffArgs: a failing git diff reports an actionable failure and returns null', async () => {
  exec.exec = async () => 1;
  const result = await resolveDiffArgs('main..HEAD', workspace, tmp);
  assert.equal(result, null);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Could not compute the diff/);
});

test('resolveDiffArgs: "true" on a PR uses the merge-base when reachable', async () => {
  github.context.payload = {
    pull_request: { base: { sha: 'BASESHA' }, head: { sha: 'HEADSHA' } },
  };
  const seen = [];
  exec.exec = async (cmd, args, opts) => {
    seen.push(args.join(' '));
    if (args.includes('merge-base')) {
      opts.listeners.stdout(Buffer.from('MERGEBASE\n'));
      return 0;
    }
    if (args.includes('diff')) {
      opts.listeners.stdout(Buffer.from('the patch\n'));
      return 0;
    }
    return 0; // fetch
  };
  const result = await resolveDiffArgs('true', workspace, tmp);
  assert.deepEqual(result, ['--diff', path.join(tmp, 'codecharter.diff')]);
  const diffCall = seen.find((s) => s.includes('diff'));
  assert.ok(diffCall.includes('MERGEBASE'), 'diff is taken from merge-base..head');
  assert.ok(diffCall.includes('HEADSHA'));
});

test('resolveDiffArgs: "true" on a PR falls back to the base tip when merge-base is unreachable', async () => {
  github.context.payload = {
    pull_request: { base: { sha: 'BASESHA' }, head: { sha: 'HEADSHA' } },
  };
  let diffCall;
  exec.exec = async (cmd, args, opts) => {
    if (args.includes('merge-base')) return 1; // unreachable in a shallow clone
    if (args.includes('diff')) {
      diffCall = args.join(' ');
      opts.listeners.stdout(Buffer.from('patch\n'));
      return 0;
    }
    return 0;
  };
  const result = await resolveDiffArgs('true', workspace, tmp);
  assert.deepEqual(result, ['--diff', path.join(tmp, 'codecharter.diff')]);
  assert.ok(diffCall.includes('BASESHA'), 'falls back to the base sha');
  assert.ok(diffCall.includes('HEADSHA'));
});
