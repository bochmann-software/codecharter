'use strict';

// `diff: true` on push events against real git repositories: a full clone after
// a force push whose old tip is still fetchable by SHA, and shallow checkouts of
// depth 1 and 2. Both modes resolve through the same code; analyze mode diffs on
// the runner and coverage mode hands the CLI a range, so both are run for every
// case and must land on the same base and head. git runs for real; the calls are
// only recorded to pin the fetch arguments.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { core, exec, github, HttpClient } from '../src/deps.js';
import { resolveDiffArgs, resolveCoverageGitRef, resolveCoverageDiffArgs, runCoverage } from '../src/index.js';

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

let root;
let originUrl;
const sha = {};

// origin: main is A-B-C-D; branch `forced` is A-B-E-F, the state after a force
// push that replaced C and D with two new commits, so the parent of F is not the
// merge-base and a parent fallback would show. uploadpack.allowAnySHA1InWant lets a clone fetch
// the old tip D by SHA, as GitHub does for a force-pushed commit.
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-push-range-'));
  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const commit = (name) => {
    fs.writeFileSync(path.join(origin, `${name}.txt`), `${name}\n`);
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', name);
    return git(origin, 'rev-parse', 'HEAD');
  };
  for (const name of ['A', 'B', 'C', 'D']) sha[name] = commit(name);
  git(origin, 'checkout', '-q', '-b', 'forced', sha.B);
  sha.E = commit('E');
  sha.F = commit('F');
  git(origin, 'checkout', '-q', 'main');
  originUrl = pathToFileURL(origin).href;
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

let warnings;
let calls;
let cliCalls;
let saved;
let tmp;

beforeEach(() => {
  warnings = [];
  calls = [];
  saved = {
    warning: core.warning,
    setFailed: core.setFailed,
    exec: exec.exec,
    payload: github.context.payload,
    eventName: github.context.eventName,
    sha: github.context.sha,
  };
  core.warning = (m) => warnings.push(m);
  core.setFailed = (m) => assert.fail(`unexpected failure: ${m}`);
  const real = saved.exec;
  cliCalls = [];
  exec.exec = (cmd, args, opts) => {
    if (cmd !== 'git') {
      cliCalls.push([cmd, ...args]);
      return 0;
    }
    calls.push(args);
    return real(cmd, args, opts);
  };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-push-range-tmp-'));
});

afterEach(() => {
  core.warning = saved.warning;
  core.setFailed = saved.setFailed;
  exec.exec = saved.exec;
  github.context.payload = saved.payload;
  github.context.eventName = saved.eventName;
  github.context.sha = saved.sha;
  fs.rmSync(tmp, { recursive: true, force: true });
});

let cloneCount = 0;
function clone(...args) {
  const dir = path.join(root, `clone-${++cloneCount}`);
  git(root, 'clone', '-q', ...args, originUrl, dir);
  return dir;
}

function push(beforeSha, headSha) {
  github.context.eventName = 'push';
  github.context.payload = { before: beforeSha };
  github.context.sha = headSha;
}

const fetchCall = () => calls.find((a) => a.includes('fetch'));

// Runs both modes, each on its own fresh clone, and returns what each resolved:
// the base..head analyze diffed on the runner, and the range coverage passes on.
async function bothModes(cloneArgs) {
  const analyzeDir = clone(...cloneArgs);
  const analyzeResult = await resolveDiffArgs('true', analyzeDir, tmp);
  const diffCall = calls.find((a) => a.includes('diff'));
  const analyze = {
    result: analyzeResult,
    range: diffCall ? diffCall.slice(-2).join('..') : null,
    fetch: fetchCall(),
    warnings: [...warnings],
  };

  calls = [];
  warnings.length = 0;
  const coverageDir = clone(...cloneArgs);
  const coverageResult = await resolveCoverageGitRef('true', coverageDir);
  const coverage = { range: coverageResult.gitRef, fetch: fetchCall(), warnings: [...warnings] };
  return { analyze, coverage, analyzeDir, coverageDir };
}

test('full clone, force push with a fetchable old tip: fetched with history, merge-base..sha in both modes', async () => {
  push(sha.D, sha.F);
  const { analyze, coverage, coverageDir } = await bothModes(['--single-branch', '--branch', 'forced']);

  for (const mode of [analyze, coverage]) {
    assert.deepEqual(mode.fetch.slice(2), ['fetch', '--no-tags', 'origin', sha.D], 'no --depth in a full clone');
    assert.equal(mode.range, `${sha.B}..${sha.F}`, 'from the common ancestor, not from the dropped tip');
    assert.deepEqual(mode.warnings, []);
  }
  assert.equal(git(coverageDir, 'rev-parse', '--is-shallow-repository'), 'false', 'the clone stays complete');
});

test('shallow depth 1, fast-forward push: no merge base and no parent, whole solution in both modes', async () => {
  push(sha.C, sha.D);
  const { analyze, coverage } = await bothModes(['--depth', '1', '--branch', 'main']);

  const reason =
    `the pushed range is unusable (\`before\` ${sha.C} has no merge base with ${sha.D} in the checkout) and ` +
    `commit ${sha.D} has no parent in the checkout: it is a root commit, or the checkout is too shallow ` +
    '(use actions/checkout with fetch-depth: 0)';
  assert.deepEqual(analyze.result, []);
  assert.deepEqual(analyze.warnings, [
    `\`diff: true\` did not scope this run: ${reason}. Analyzing the whole solution.`,
  ]);
  assert.equal(coverage.range, null);
  assert.deepEqual(coverage.warnings, [
    `\`diff: true\` did not scope this run: ${reason}. Gating whole-solution coverage instead.`,
  ]);
  for (const mode of [analyze, coverage]) {
    assert.deepEqual(mode.fetch.slice(2), ['fetch', '--no-tags', '--depth=1', 'origin', sha.C]);
  }
});

test('shallow depth 2, push of two commits: no merge base, parent..sha with a warning in both modes', async () => {
  push(sha.B, sha.D);
  const { analyze, coverage } = await bothModes(['--depth', '2', '--branch', 'main']);

  const warning =
    `The push's previous tip ${sha.B} has no merge base with ${sha.D} in the checkout: the push rewrote ` +
    'history, or the checkout is shallow (use actions/checkout with fetch-depth: 0 to gate the whole pushed ' +
    `range). Comparing ${sha.D} with its parent instead.`;
  for (const mode of [analyze, coverage]) {
    assert.equal(mode.range, `${sha.C}..${sha.D}`);
    assert.deepEqual(mode.warnings, [warning]);
    assert.deepEqual(mode.fetch.slice(2), ['fetch', '--no-tags', '--depth=1', 'origin', sha.B]);
  }
});

test('shallow depth 2, push of one commit: before is the merge base, no warning in both modes', async () => {
  push(sha.C, sha.D);
  const { analyze, coverage } = await bothModes(['--depth', '2', '--branch', 'main']);
  for (const mode of [analyze, coverage]) {
    assert.equal(mode.range, `${sha.C}..${sha.D}`);
    assert.deepEqual(mode.warnings, []);
  }
});

// ---------------------------------------------------------------------------
// pull requests: base D on main, head F on `forced`, merge-base B
// ---------------------------------------------------------------------------

function pullRequest() {
  github.context.eventName = 'pull_request';
  github.context.payload = { pull_request: { number: 1, base: { sha: sha.D }, head: { sha: sha.F } } };
}

test('pull request, shallow depth 1: coverage fails before any test run, analyze still diffs the tips', async (t) => {
  pullRequest();
  const failures = [];
  core.setFailed = (m) => failures.push(m);
  // Enough of an environment for runCoverage to finish if it wrongly went on to
  // run the CLI, so a regression shows up in the assertions below rather than
  // as an unrelated crash.
  const savedRepo = process.env.GITHUB_REPOSITORY;
  const savedPost = HttpClient.prototype.post;
  const savedOutput = core.setOutput;
  process.env.GITHUB_REPOSITORY = 'acme/app';
  HttpClient.prototype.post = async () => ({ message: { statusCode: 404 }, readBody: async () => '' });
  core.setOutput = () => {};
  t.after(() => {
    if (savedRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = savedRepo;
    HttpClient.prototype.post = savedPost;
    core.setOutput = savedOutput;
  });

  const coverageDir = clone('--depth', '1', '--branch', 'forced');
  await runCoverage({
    exe: 'codecharter',
    env: {},
    workspace: coverageDir,
    tmp,
    portal: 'https://portal.invalid',
    apiKey: 'KEY',
    options: { root: '', diff: 'true', minDiffCoverage: '100', failOnThreshold: true, wantComment: false },
  });
  assert.deepEqual(failures, [
    `Cannot gate the pull request's changed lines: the merge base between base ${sha.D} and head ${sha.F} ` +
      'is not in the checkout. Coverage diff mode needs it. What to do: check out with `fetch-depth: 0` on ' +
      'actions/checkout.',
  ]);
  assert.deepEqual(cliCalls, [], 'the CLI (and with it the test run) never started');
  assert.deepEqual(fetchCall().slice(2), ['fetch', '--no-tags', '--depth=1', 'origin', sha.D]);

  // Analyze mode keeps its behaviour: the tips are diffed directly.
  calls = [];
  const analyzeDir = clone('--depth', '1', '--branch', 'forced');
  const result = await resolveDiffArgs('true', analyzeDir, tmp);
  assert.deepEqual(result, ['--diff', path.join(tmp, 'codecharter.diff')]);
  assert.deepEqual(calls.at(-1).slice(-2), [sha.D, sha.F]);
  assert.equal(failures.length, 1, 'analyze mode does not fail');
});

test('pull request, full history: coverage gates merge-base..head', async () => {
  pullRequest();
  const dir = clone('--branch', 'forced');
  assert.deepEqual(await resolveCoverageDiffArgs({ diff: 'true', minDiffCoverage: '100' }, dir), [
    '--git-ref',
    `${sha.B}..${sha.F}`,
    '--min-diff-coverage',
    '100',
  ]);
  assert.deepEqual(fetchCall().slice(2), ['fetch', '--no-tags', 'origin', sha.D]);
});
