'use strict';

// Filesystem-backed helpers run against real temp trees rather than mocks, so
// the directory walking, ordering and skip rules are exercised end to end.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { discoverSolutions, hasConfiguredProfiles, findExecutable, readJson, verifySha } from '../src/index.js';

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fs-test-'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function tmpdir(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

// ---------------------------------------------------------------------------
// discoverSolutions
// ---------------------------------------------------------------------------

test('discoverSolutions: empty workspace → empty list', () => {
  assert.deepEqual(discoverSolutions(tmpdir('empty')), []);
});

test('discoverSolutions: prefers .sln/.slnx over .csproj entirely', () => {
  const ws = tmpdir('prefers');
  touch(path.join(ws, 'App.csproj'));
  touch(path.join(ws, 'deep', 'Other.csproj'));
  touch(path.join(ws, 'Solution.sln'));
  const found = discoverSolutions(ws);
  assert.deepEqual(found, ['Solution.sln'], 'csproj is dropped once a solution exists');
});

test('discoverSolutions: .slnx is treated as a solution file', () => {
  const ws = tmpdir('slnx');
  touch(path.join(ws, 'Modern.slnx'));
  touch(path.join(ws, 'App.csproj'));
  assert.deepEqual(discoverSolutions(ws), ['Modern.slnx']);
});

test('discoverSolutions: shallowest dir first, then alphabetical', () => {
  const ws = tmpdir('ordering');
  touch(path.join(ws, 'b', 'Deep.sln'));
  touch(path.join(ws, 'Beta.sln'));
  touch(path.join(ws, 'Alpha.sln'));
  const found = discoverSolutions(ws);
  assert.deepEqual(found, ['Alpha.sln', 'Beta.sln', path.join('b', 'Deep.sln')]);
});

test('discoverSolutions: falls back to .csproj, ordered, when no solution exists', () => {
  const ws = tmpdir('csproj-only');
  touch(path.join(ws, 'z', 'Z.csproj'));
  touch(path.join(ws, 'A.csproj'));
  assert.deepEqual(discoverSolutions(ws), ['A.csproj', path.join('z', 'Z.csproj')]);
});

test('discoverSolutions: skips node_modules, bin, obj and .git', () => {
  const ws = tmpdir('skips');
  touch(path.join(ws, 'node_modules', 'Pkg.sln'));
  touch(path.join(ws, 'bin', 'Bin.sln'));
  touch(path.join(ws, 'obj', 'Obj.sln'));
  touch(path.join(ws, '.git', 'Git.sln'));
  touch(path.join(ws, 'Real.sln'));
  assert.deepEqual(discoverSolutions(ws), ['Real.sln']);
});

test('discoverSolutions: extension match is case-insensitive', () => {
  const ws = tmpdir('case');
  touch(path.join(ws, 'Upper.SLN'));
  assert.deepEqual(discoverSolutions(ws), ['Upper.SLN']);
});

// ---------------------------------------------------------------------------
// hasConfiguredProfiles
// ---------------------------------------------------------------------------

function writeConfig(name, body) {
  const ws = tmpdir(name);
  const dir = path.join(ws, '.codeguard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yml'), body);
  return ws;
}

test('hasConfiguredProfiles: no .codeguard/config.yml → false', () => {
  assert.equal(hasConfiguredProfiles(tmpdir('cfg-none')), false);
});

test('hasConfiguredProfiles: block-list profiles → true', () => {
  const ws = writeConfig(
    'cfg-block',
    'version: 1\nprofiles:\n  - codeguard/csharp-all@latest\nexclude:\n  - "tests/**"\n'
  );
  assert.equal(hasConfiguredProfiles(ws), true);
});

test('hasConfiguredProfiles: flow-list profiles → true', () => {
  const ws = writeConfig('cfg-flow', 'version: 1\nprofiles: [codeguard/csharp-all@latest]\n');
  assert.equal(hasConfiguredProfiles(ws), true);
});

test('hasConfiguredProfiles: empty block list → false', () => {
  // `profiles:` with no items and then another top-level key must not count.
  const ws = writeConfig('cfg-empty-block', 'version: 1\nprofiles:\nexclude:\n  - "tests/**"\n');
  assert.equal(hasConfiguredProfiles(ws), false);
});

test('hasConfiguredProfiles: empty flow list → false', () => {
  const ws = writeConfig('cfg-empty-flow', 'version: 1\nprofiles: []\n');
  assert.equal(hasConfiguredProfiles(ws), false);
});

test('hasConfiguredProfiles: no profiles key at all → false', () => {
  const ws = writeConfig('cfg-noprofiles', 'version: 1\nexclude:\n  - "tests/**"\n');
  assert.equal(hasConfiguredProfiles(ws), false);
});

test('hasConfiguredProfiles: a commented-out profile item does not count', () => {
  const ws = writeConfig(
    'cfg-comment',
    'version: 1\nprofiles:\n  # - codeguard/csharp-all@latest\nexclude:\n  - "tests/**"\n'
  );
  assert.equal(hasConfiguredProfiles(ws), false);
});

test('hasConfiguredProfiles: item with an inline trailing comment still counts', () => {
  const ws = writeConfig('cfg-trailing', 'profiles:\n  - codeguard/csharp-all@latest # pinned\n');
  assert.equal(hasConfiguredProfiles(ws), true);
});

// ---------------------------------------------------------------------------
// findExecutable
// ---------------------------------------------------------------------------

test('findExecutable: finds the non-windows binary by either name, nested', () => {
  const ws = tmpdir('exe-nix');
  const target = path.join(ws, 'a', 'b', 'CodeGuard.Cli');
  touch(target);
  assert.equal(findExecutable(ws, false), target);
});

test('findExecutable: finds the lower-case codeguard binary', () => {
  const ws = tmpdir('exe-nix2');
  const target = path.join(ws, 'codeguard');
  touch(target);
  assert.equal(findExecutable(ws, false), target);
});

test('findExecutable: windows looks for the .exe names only', () => {
  const ws = tmpdir('exe-win');
  touch(path.join(ws, 'codeguard')); // no extension — ignored on windows
  const target = path.join(ws, 'tools', 'codeguard.exe');
  touch(target);
  assert.equal(findExecutable(ws, true), target);
});

test('findExecutable: returns null when nothing matches', () => {
  const ws = tmpdir('exe-none');
  touch(path.join(ws, 'readme.txt'));
  assert.equal(findExecutable(ws, false), null);
});

// ---------------------------------------------------------------------------
// readJson
// ---------------------------------------------------------------------------

test('readJson: parses valid JSON', () => {
  const ws = tmpdir('json-ok');
  const file = path.join(ws, 'r.json');
  fs.writeFileSync(file, JSON.stringify({ violations: [{ severity: 'error' }] }));
  assert.deepEqual(readJson(file), { violations: [{ severity: 'error' }] });
});

test('readJson: missing file → null', () => {
  assert.equal(readJson(path.join(root, 'does-not-exist.json')), null);
});

test('readJson: invalid JSON → null', () => {
  const ws = tmpdir('json-bad');
  const file = path.join(ws, 'bad.json');
  fs.writeFileSync(file, '{ not valid');
  assert.equal(readJson(file), null);
});

// ---------------------------------------------------------------------------
// verifySha
// ---------------------------------------------------------------------------

test('verifySha: null/empty expected digest is a no-op (never reads the file)', async () => {
  await assert.doesNotReject(verifySha(path.join(root, 'missing.bin'), null));
  await assert.doesNotReject(verifySha(path.join(root, 'missing.bin'), ''));
});

test('verifySha: matching digest resolves', async () => {
  const ws = tmpdir('sha-ok');
  const file = path.join(ws, 'archive.bin');
  const data = Buffer.from('codeguard archive contents');
  fs.writeFileSync(file, data);
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  await assert.doesNotReject(verifySha(file, sha));
});

test('verifySha: mismatching digest rejects with an actionable message', async () => {
  const ws = tmpdir('sha-bad');
  const file = path.join(ws, 'archive.bin');
  fs.writeFileSync(file, 'real');
  const wrong = crypto.createHash('sha256').update('different').digest('hex');
  await assert.rejects(verifySha(file, wrong), /SHA-256 mismatch/);
});
