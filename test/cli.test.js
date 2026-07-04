// obtainCli resolves the codeguard executable, preferring the Actions cache.
// For moving selectors it first resolves the concrete version via the manifest
// endpoint and keys the cache by it; exact pins skip that lookup. The
// download/extract path is covered indirectly by the downloadArchive and
// verifySha unit tests; here we exercise the cache-hit shortcut and the version
// resolution with the cache/io/HTTP layers mocked, against a real temp dir.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cache, io, core, HttpClient } from '../src/deps.js';
import { obtainCli, fetchManifest } from '../src/index.js';

let toolCache;
let tmp;
let saved;

beforeEach(() => {
  toolCache = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-toolcache-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-tmp-'));
  saved = {
    runnerToolCache: process.env.RUNNER_TOOL_CACHE,
    isFeatureAvailable: cache.isFeatureAvailable,
    restoreCache: cache.restoreCache,
    saveCache: cache.saveCache,
    which: io.which,
    info: core.info,
    warning: core.warning,
    debug: core.debug,
    get: HttpClient.prototype.get,
  };
  process.env.RUNNER_TOOL_CACHE = toolCache;
  core.info = () => {};
  core.warning = () => {};
  core.debug = () => {};
});

afterEach(() => {
  if (saved.runnerToolCache === undefined) delete process.env.RUNNER_TOOL_CACHE;
  else process.env.RUNNER_TOOL_CACHE = saved.runnerToolCache;
  cache.isFeatureAvailable = saved.isFeatureAvailable;
  cache.restoreCache = saved.restoreCache;
  cache.saveCache = saved.saveCache;
  io.which = saved.which;
  core.info = saved.info;
  core.warning = saved.warning;
  core.debug = saved.debug;
  HttpClient.prototype.get = saved.get;
  fs.rmSync(toolCache, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Stubs the manifest GET and counts how many times it is called.
function stubManifestGet({ statusCode = 200, body = '' } = {}) {
  const state = { calls: 0, lastUrl: null };
  HttpClient.prototype.get = async (url) => {
    state.calls++;
    state.lastUrl = url;
    return { message: { statusCode }, readBody: async () => body };
  };
  return state;
}

// Makes the cache "hit": restoreCache plants the executable into the dir the
// action prepared and returns the key, like a real restore would.
function cacheHitPlanting(exeName) {
  cache.isFeatureAvailable = () => true;
  io.which = async () => '/usr/bin/gzip';
  cache.saveCache = async () => {};
  const planted = { key: null, dir: null };
  cache.restoreCache = async (paths, key) => {
    planted.key = key;
    planted.dir = paths[0];
    fs.writeFileSync(path.join(paths[0], exeName), '#!/bin/sh\n');
    return key;
  };
  return planted;
}

// --- obtainCli: version resolution & caching --------------------------------

test('obtainCli: an exact pin skips the manifest lookup and keys by the pin', async () => {
  const platform = 'linux-x64';
  const version = 'v1.2.3';
  const http = stubManifestGet({ statusCode: 200, body: '{}' });
  const planted = cacheHitPlanting('codeguard');

  const exe = await obtainCli({
    portal: 'https://portal',
    platform,
    version,
    apiKey: 'KEY',
    isWindows: false,
    tmp,
    cacheEnabled: true,
  });

  assert.equal(http.calls, 0, 'exact pins never call the manifest endpoint');
  assert.equal(exe, path.join(toolCache, 'codecharter-cli', platform, version, 'codeguard'));
  assert.equal(planted.key, `codecharter-cli-${platform}-${version}`);
});

test('obtainCli: a moving selector keys the cache by the manifest-resolved version', async () => {
  const platform = 'linux-x64';
  const http = stubManifestGet({
    statusCode: 200,
    body: JSON.stringify({ version: '1.7.0', platform, filename: 'codeguard-1.7.0-linux-x64.tar.gz', sha256: 'abc' }),
  });
  const planted = cacheHitPlanting('CodeGuard.Cli');

  const exe = await obtainCli({
    portal: 'https://portal',
    platform,
    version: 'latest',
    apiKey: 'KEY',
    isWindows: false,
    tmp,
    cacheEnabled: true,
  });

  assert.equal(http.calls, 1);
  assert.match(http.lastUrl, /\/api\/v1\/cli\/linux-x64\/latest\/manifest$/);
  // Keyed by the resolved version — no per-day suffix.
  assert.equal(planted.key, `codecharter-cli-${platform}-1.7.0`);
  assert.equal(exe, path.join(toolCache, 'codecharter-cli', platform, '1.7.0', 'CodeGuard.Cli'));
});

test('obtainCli: when the manifest endpoint is unavailable, fall back to a per-day key', async () => {
  const platform = 'linux-x64';
  stubManifestGet({ statusCode: 404, body: '' }); // older portal: no manifest route
  const planted = cacheHitPlanting('codeguard');

  await obtainCli({
    portal: 'https://portal',
    platform,
    version: 'v1',
    apiKey: 'KEY',
    isWindows: false,
    tmp,
    cacheEnabled: true,
  });

  assert.match(planted.key, new RegExp(`^codecharter-cli-${platform}-v1-\\d{4}-\\d{2}-\\d{2}$`));
});

// --- fetchManifest ----------------------------------------------------------

test('fetchManifest: 200 with a valid body returns the parsed manifest', async () => {
  stubManifestGet({ statusCode: 200, body: JSON.stringify({ version: '1.7.0', sha256: 'abc' }) });
  const m = await fetchManifest('https://portal', 'linux-x64', 'latest', 'KEY');
  assert.equal(m.version, '1.7.0');
  assert.equal(m.sha256, 'abc');
});

test('fetchManifest: a non-2xx status returns null', async () => {
  stubManifestGet({ statusCode: 404, body: 'nope' });
  assert.equal(await fetchManifest('https://portal', 'linux-x64', 'latest', 'KEY'), null);
});

test('fetchManifest: an invalid JSON body returns null', async () => {
  stubManifestGet({ statusCode: 200, body: 'not json' });
  assert.equal(await fetchManifest('https://portal', 'linux-x64', 'latest', 'KEY'), null);
});

test('fetchManifest: a 200 body without a version field returns null', async () => {
  stubManifestGet({ statusCode: 200, body: JSON.stringify({ sha256: 'abc' }) });
  assert.equal(await fetchManifest('https://portal', 'linux-x64', 'latest', 'KEY'), null);
});

test('fetchManifest: a network error is swallowed and returns null', async () => {
  HttpClient.prototype.get = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.equal(await fetchManifest('https://portal', 'linux-x64', 'latest', 'KEY'), null);
});
