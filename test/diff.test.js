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
import { resolveDiffArgs, resolveEventRange } from '../src/index.js';

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
    eventName: github.context.eventName,
    sha: github.context.sha,
  };
  core.warning = (m) => warnings.push(m);
  core.setFailed = (m) => failures.push(m);
  core.info = () => {};
  github.context.payload = {};
  // Pinned so the host's own GITHUB_EVENT_NAME (a CI run is a push or a
  // pull_request itself) never decides which branch these tests take.
  github.context.eventName = 'workflow_dispatch';
  github.context.sha = 'PUSHSHA';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-diff-test-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ws-test-'));
});

afterEach(() => {
  core.warning = saved.warning;
  core.setFailed = saved.setFailed;
  core.info = saved.info;
  exec.exec = saved.execExec;
  github.context.payload = saved.payload;
  github.context.eventName = saved.eventName;
  github.context.sha = saved.sha;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('resolveDiffArgs: empty and "false" (any case) → no diff args', async () => {
  assert.deepEqual(await resolveDiffArgs('', workspace, tmp), []);
  assert.deepEqual(await resolveDiffArgs('   ', workspace, tmp), []);
  assert.deepEqual(await resolveDiffArgs('false', workspace, tmp), []);
  assert.deepEqual(await resolveDiffArgs('FALSE', workspace, tmp), []);
});

test('resolveDiffArgs: "true" on an event without a range warns, naming the event, and disables diff', async () => {
  github.context.payload = {}; // not a PR
  github.context.eventName = 'schedule';
  const calls = [];
  exec.exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return 0;
  };
  const result = await resolveDiffArgs('true', workspace, tmp);
  assert.deepEqual(result, []);
  assert.deepEqual(warnings, [
    '`diff: true` did not scope this run: only pull_request and push events have changed lines to compare, ' +
      'and this is a `schedule` event. Analyzing the whole solution.',
  ]);
  assert.deepEqual(calls, [], 'no git command runs for an event without a range');
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

// ---------------------------------------------------------------------------
// push events
// ---------------------------------------------------------------------------

// Records every git call and answers them like a checkout with history: the
// merge-base of anything is MERGEBASE, and PUSHSHA~1 resolves to PARENTSHA
// unless the test says the commit has no parent.
function recordGit({ parent = 'PARENTSHA', mergeBase = 'MERGEBASE' } = {}) {
  const calls = [];
  exec.exec = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (args.includes('rev-parse')) {
      if (!parent) return 1;
      opts.listeners.stdout(Buffer.from(`${parent}\n`));
      return 0;
    }
    if (args.includes('merge-base')) {
      if (!mergeBase) return 1;
      opts.listeners.stdout(Buffer.from(`${mergeBase}\n`));
      return 0;
    }
    if (args.includes('diff')) {
      opts.listeners.stdout(Buffer.from('patch\n'));
      return 0;
    }
    return 0; // fetch
  };
  return calls;
}

test('resolveDiffArgs: "true" on a push diffs before..sha through the merge-base', async () => {
  github.context.eventName = 'push';
  github.context.payload = { before: 'BEFORESHA' };
  const calls = recordGit();
  const result = await resolveDiffArgs('true', workspace, tmp);
  assert.deepEqual(result, ['--diff', path.join(tmp, 'codecharter.diff')]);
  assert.deepEqual(calls, [
    ['git', '-C', workspace, 'fetch', '--no-tags', '--depth=1', 'origin', 'BEFORESHA'],
    ['git', '-C', workspace, 'merge-base', 'BEFORESHA', 'PUSHSHA'],
    ['git', '-C', workspace, 'diff', '--unified=0', 'MERGEBASE', 'PUSHSHA'],
  ]);
  assert.deepEqual(warnings, []);
});

test('resolveDiffArgs: "true" on a push keeps before when its merge-base is unreachable', async () => {
  github.context.eventName = 'push';
  github.context.payload = { before: 'BEFORESHA' };
  const calls = recordGit({ mergeBase: '' });
  await resolveDiffArgs('true', workspace, tmp);
  assert.deepEqual(calls.at(-1), ['git', '-C', workspace, 'diff', '--unified=0', 'BEFORESHA', 'PUSHSHA']);
});

test('resolveDiffArgs: "true" on a push with the all-zero before diffs the commit against its parent', async () => {
  github.context.eventName = 'push';
  github.context.payload = { before: '0000000000000000000000000000000000000000' };
  const calls = recordGit();
  const result = await resolveDiffArgs('true', workspace, tmp);
  assert.deepEqual(result, ['--diff', path.join(tmp, 'codecharter.diff')]);
  assert.deepEqual(calls, [
    ['git', '-C', workspace, 'rev-parse', '--verify', '--quiet', 'PUSHSHA~1^{commit}'],
    ['git', '-C', workspace, 'diff', '--unified=0', 'PARENTSHA', 'PUSHSHA'],
  ]);
  assert.deepEqual(warnings, []);
});

test('resolveDiffArgs: "true" on a push of a root commit warns why and analyzes the whole solution', async () => {
  github.context.eventName = 'push';
  github.context.payload = { before: '0000000000000000000000000000000000000000' };
  const calls = recordGit({ parent: '' });
  const result = await resolveDiffArgs('true', workspace, tmp);
  assert.deepEqual(result, []);
  assert.deepEqual(warnings, [
    '`diff: true` did not scope this run: this push has no previous tip (`before` is the all-zero SHA) and ' +
      'commit PUSHSHA has no parent in the checkout: it is a root commit, or the checkout is too shallow ' +
      '(use actions/checkout with fetch-depth: 2 or more). Analyzing the whole solution.',
  ]);
  assert.equal(
    calls.some((c) => c.includes('diff')),
    false,
    'no diff is computed'
  );
});

test('resolveEventRange: an empty before is treated like the all-zero SHA and says so', async () => {
  github.context.eventName = 'push';
  github.context.payload = {};
  recordGit();
  assert.deepEqual(await resolveEventRange(workspace), { base: 'PARENTSHA', head: 'PUSHSHA' });

  recordGit({ parent: '' });
  const skipped = await resolveEventRange(workspace);
  assert.match(skipped.skipped, /^this push has no previous tip \(`before` is empty\)/);
});

test('resolveEventRange: a pull request wins over the push fields', async () => {
  github.context.eventName = 'push';
  github.context.payload = {
    before: 'BEFORESHA',
    pull_request: { base: { sha: 'BASESHA' }, head: { sha: 'HEADSHA' } },
  };
  const calls = recordGit();
  assert.deepEqual(await resolveEventRange(workspace), { base: 'MERGEBASE', head: 'HEADSHA' });
  assert.deepEqual(calls[1], ['git', '-C', workspace, 'merge-base', 'BASESHA', 'HEADSHA']);
});

test('resolveEventRange: names an unknown event when the context has none', async () => {
  github.context.eventName = undefined;
  const result = await resolveEventRange(workspace);
  assert.match(result.skipped, /this is a `unknown` event$/);
});
