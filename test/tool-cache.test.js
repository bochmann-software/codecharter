// obtainCli on a tool cache shared by several runners on one machine (#6074).
//
// Concurrent jobs must never rewrite a cached CLI version another job is
// running from: a complete version (marker file present) is reused as-is, a
// fresh install is assembled in a per-run staging directory and renamed into
// place, and the job that loses the rename race uses the winner's copy. The
// archive extraction is stubbed (it writes the files the real archive would)
// and files of a copy "in use" refuse to be unlinked or overwritten with EPERM,
// as Windows does for a running codecharter.dll.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { cache, io, core, tc, HttpClient } from '../src/deps.js';
import * as action from '../src/index.js';

const { obtainCli } = action;

// The completion marker the action writes last into a published CLI copy.
const CLI_COMPLETE_MARKER = '.codecharter-complete';

const PLATFORM = 'linux-x64';
const VERSION = '1.6.7';

let toolCache;
let runnerTemp;
let tmps;
let saved;
let inUse; // absolute paths of files a running job holds open
let downloads;
let warnings;

function eperm(op, file) {
  const err = new Error(`EPERM: operation not permitted, ${op} '${file}'`);
  err.code = 'EPERM';
  return err;
}

function isInUse(target) {
  const resolved = path.resolve(target);
  return [...inUse].some((file) => file === resolved || file.startsWith(resolved + path.sep));
}

// Marks every file of an installed copy as held open by a running job.
function lockCopy(dir) {
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) inUse.add(path.resolve(entry.parentPath, entry.name));
  }
}

// Writes the files a CLI archive contains, refusing to overwrite one in use.
function writeCliFiles(dest, payload) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ['codecharter', 'codecharter.dll', 'CodeCharter.Dsl.dll']) {
    const file = path.join(dest, name);
    if (isInUse(file)) throw eperm('open', file);
    fs.writeFileSync(file, payload);
  }
}

function cliDir() {
  return path.join(toolCache, 'codecharter-cli', PLATFORM, VERSION);
}

function newTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shared-tmp-'));
  tmps.push(dir);
  return dir;
}

function install(overrides = {}) {
  return obtainCli({
    portal: 'https://portal',
    platform: PLATFORM,
    version: VERSION,
    apiKey: 'KEY',
    isWindows: false,
    tmp: newTmp(),
    cacheEnabled: true,
    ...overrides,
  });
}

// Plants a complete (marker-carrying) install, as a previous job published it.
function plantComplete(payload = 'installed') {
  writeCliFiles(cliDir(), payload);
  fs.writeFileSync(path.join(cliDir(), CLI_COMPLETE_MARKER), '{}');
}

function stagingLeftovers() {
  return fs.readdirSync(path.dirname(cliDir())).filter((name) => name !== VERSION);
}

beforeEach(() => {
  toolCache = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shared-toolcache-'));
  runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-shared-runnertemp-'));
  tmps = [];
  inUse = new Set();
  downloads = 0;
  warnings = [];
  saved = {
    runnerToolCache: process.env.RUNNER_TOOL_CACHE,
    runnerTemp: process.env.RUNNER_TEMP,
    isFeatureAvailable: cache.isFeatureAvailable,
    restoreCache: cache.restoreCache,
    saveCache: cache.saveCache,
    which: io.which,
    rmRF: io.rmRF,
    extractTar: tc.extractTar,
    info: core.info,
    warning: core.warning,
    debug: core.debug,
    get: HttpClient.prototype.get,
    renameSync: fs.renameSync,
  };
  process.env.RUNNER_TOOL_CACHE = toolCache;
  process.env.RUNNER_TEMP = runnerTemp;
  core.info = () => {};
  core.debug = () => {};
  core.warning = (msg) => warnings.push(msg);
  cache.isFeatureAvailable = () => false;
  HttpClient.prototype.get = async () => {
    downloads++;
    return {
      message: Object.assign(Readable.from([Buffer.from('archive')]), { statusCode: 200, headers: {} }),
      readBody: async () => '',
    };
  };
  // Removing a copy in use fails like Windows does for a loaded codecharter.dll.
  io.rmRF = async (target) => {
    if (isInUse(target))
      throw eperm(
        'unlink',
        [...inUse].find((f) => f.startsWith(path.resolve(target)))
      );
    return saved.rmRF(target);
  };
  tc.extractTar = async (_archive, dest) => {
    writeCliFiles(dest, `extracted-${downloads}`);
    return dest;
  };
});

afterEach(() => {
  for (const [key, env] of [
    ['RUNNER_TOOL_CACHE', saved.runnerToolCache],
    ['RUNNER_TEMP', saved.runnerTemp],
  ]) {
    if (env === undefined) delete process.env[key];
    else process.env[key] = env;
  }
  cache.isFeatureAvailable = saved.isFeatureAvailable;
  cache.restoreCache = saved.restoreCache;
  cache.saveCache = saved.saveCache;
  io.which = saved.which;
  io.rmRF = saved.rmRF;
  tc.extractTar = saved.extractTar;
  core.info = saved.info;
  core.warning = saved.warning;
  core.debug = saved.debug;
  HttpClient.prototype.get = saved.get;
  fs.renameSync = saved.renameSync;
  for (const dir of [toolCache, runnerTemp, ...tmps]) fs.rmSync(dir, { recursive: true, force: true });
});

test('obtainCli_WhenACompleteVersionIsInUse_ReusesItWithoutRewriting', async () => {
  plantComplete('installed');
  lockCopy(cliDir());

  const exe = await install();

  assert.equal(exe, path.join(cliDir(), 'codecharter'));
  assert.equal(downloads, 0, 'a complete cached version is never downloaded again');
  assert.equal(fs.readFileSync(path.join(cliDir(), 'codecharter.dll'), 'utf8'), 'installed');
});

test('obtainCli_WhenTheToolCacheIsCold_PublishesAMarkedCopyAndLeavesNoStaging', async () => {
  const exe = await install();

  assert.equal(exe, path.join(cliDir(), 'codecharter'));
  assert.ok(fs.existsSync(path.join(cliDir(), CLI_COMPLETE_MARKER)), 'the published copy carries the marker');
  assert.deepEqual(stagingLeftovers(), []);
  assert.equal((fs.statSync(exe).mode & 0o111) !== 0 || process.platform === 'win32', true);
});

test('obtainCli_WhenAnotherJobRunsTheCopyItInstalled_DoesNotExtractOverIt', async () => {
  // Job A installs and starts running the CLI; job B on another runner sharing
  // the tool cache starts right after and must not touch A's open files.
  const first = await install();
  lockCopy(cliDir());

  const second = await install();

  assert.equal(second, first);
  assert.equal(downloads, 1, 'job B reuses the complete copy job A published');
  assert.equal(fs.readFileSync(path.join(cliDir(), 'codecharter.dll'), 'utf8'), 'extracted-1');
});

test('obtainCli_WhenTwoJobsInstallConcurrently_TheLoserUsesTheWinnersCopy', async () => {
  // Both jobs miss the cache and extract at the same time. Job A publishes
  // first and starts running; job B finishes extracting afterwards.
  let releaseB;
  const bMayFinish = new Promise((resolve) => (releaseB = resolve));
  const tmpA = newTmp();
  const tmpB = newTmp();
  tc.extractTar = async (archive, dest) => {
    const isB = archive.startsWith(tmpB + path.sep);
    if (isB) await bMayFinish;
    writeCliFiles(dest, isB ? 'extracted-by-B' : 'extracted-by-A');
    return dest;
  };

  const jobA = install({ tmp: tmpA });
  const jobB = install({ tmp: tmpB });
  const exeA = await jobA;
  lockCopy(cliDir());
  releaseB();
  const exeB = await jobB;

  assert.equal(exeA, path.join(cliDir(), 'codecharter'));
  assert.equal(exeB, exeA, 'the job that lost the publish race runs the winner copy');
  assert.equal(downloads, 2);
  assert.equal(fs.readFileSync(path.join(cliDir(), 'codecharter.dll'), 'utf8'), 'extracted-by-A');
  assert.deepEqual(stagingLeftovers(), [], 'the losing staging copy is discarded');
});

test('obtainCli_WhenAHalfExtractedFolderIsLeft_ReplacesItWithACompleteCopy', async () => {
  // A crashed in-place extraction (older action version) left files but no marker.
  writeCliFiles(cliDir(), 'half');

  const exe = await install();

  assert.equal(exe, path.join(cliDir(), 'codecharter'));
  assert.equal(downloads, 1, 'a folder without the marker is never used');
  assert.ok(fs.existsSync(path.join(cliDir(), CLI_COMPLETE_MARKER)));
  assert.equal(fs.readFileSync(path.join(cliDir(), 'codecharter.dll'), 'utf8'), 'extracted-1');
  assert.deepEqual(stagingLeftovers(), [], 'the half-extracted folder is moved aside and removed');
});

test('obtainCli_WhenAnUnmarkedFolderIsInUseAndCannotMove_RunsFromItsOwnStagingCopy', async () => {
  writeCliFiles(cliDir(), 'old-action');
  lockCopy(cliDir());
  // Windows refuses to rename a directory whose files are open.
  fs.renameSync = (from, to) => {
    if (isInUse(from)) throw eperm('rename', from);
    return saved.renameSync(from, to);
  };

  const exe = await install();

  assert.notEqual(path.dirname(exe), cliDir());
  assert.equal(path.dirname(path.dirname(exe)), path.dirname(cliDir()), 'the staging copy is a sibling');
  assert.ok(fs.existsSync(path.join(path.dirname(exe), CLI_COMPLETE_MARKER)));
  assert.equal(fs.readFileSync(path.join(cliDir(), 'codecharter.dll'), 'utf8'), 'old-action');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /without a completion marker .* cannot be moved aside \(EPERM\)/);
});

test('obtainCli_WhenAMovedAsideFolderCannotBeRemoved_StillPublishes', async () => {
  writeCliFiles(cliDir(), 'half');
  const realRmRF = io.rmRF;
  io.rmRF = async (target) => {
    if (path.basename(target).includes('.stale-')) throw eperm('unlink', target);
    return realRmRF(target);
  };

  const exe = await install();

  assert.equal(exe, path.join(cliDir(), 'codecharter'));
  assert.ok(fs.existsSync(path.join(cliDir(), CLI_COMPLETE_MARKER)));
});

test('obtainCli_WhenTheFolderVanishesBeforeItIsMovedAside_RetriesThePublish', async () => {
  writeCliFiles(cliDir(), 'half');
  let removedOnce = false;
  fs.renameSync = (from, to) => {
    if (!removedOnce && path.resolve(from) === path.resolve(cliDir())) {
      // Another job cleared the leftover between our two renames.
      removedOnce = true;
      fs.rmSync(cliDir(), { recursive: true, force: true });
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return saved.renameSync(from, to);
  };

  const exe = await install();

  assert.equal(exe, path.join(cliDir(), 'codecharter'));
  assert.ok(removedOnce);
  assert.ok(fs.existsSync(path.join(cliDir(), CLI_COMPLETE_MARKER)));
});

test('obtainCli_WhenCacheIsDisabled_InstallsPrivatelyAndLeavesTheSharedCopyAlone', async () => {
  plantComplete('installed');
  lockCopy(cliDir());
  const tmp = newTmp();

  const exe = await install({ cacheEnabled: false, tmp });

  assert.ok(exe.startsWith(tmp + path.sep), 'cache: false always downloads into the run temp dir');
  assert.equal(downloads, 1);
  assert.equal(fs.readFileSync(path.join(cliDir(), 'codecharter.dll'), 'utf8'), 'installed');
});

test('obtainCli_WhenTheActionsCacheHits_RestoresOutsideTheSharedToolCache', async () => {
  cache.isFeatureAvailable = () => true;
  io.which = async () => '/usr/bin/gzip';
  const restored = [];
  cache.restoreCache = async (paths, key) => {
    restored.push(paths[0]);
    writeCliFiles(paths[0], 'from-actions-cache');
    return key;
  };
  cache.saveCache = async () => assert.fail('a cache hit is not saved again');

  const exe = await install();

  assert.equal(exe, path.join(cliDir(), 'codecharter'));
  assert.equal(downloads, 0);
  assert.ok(restored[0].startsWith(runnerTemp + path.sep), 'restore targets a runner-local transit dir');
  assert.equal(fs.readFileSync(path.join(cliDir(), 'codecharter.dll'), 'utf8'), 'from-actions-cache');
  assert.ok(fs.existsSync(path.join(cliDir(), CLI_COMPLETE_MARKER)));
});

test('obtainCli_WhenTheActionsCacheMisses_SavesTheRunnerLocalTransitDir', async () => {
  cache.isFeatureAvailable = () => true;
  io.which = async () => '/usr/bin/gzip';
  cache.restoreCache = async () => undefined;
  const savedPaths = [];
  cache.saveCache = async (paths) => savedPaths.push(paths[0]);

  const exe = await install();

  assert.equal(exe, path.join(cliDir(), 'codecharter'));
  assert.equal(savedPaths.length, 1);
  assert.ok(savedPaths[0].startsWith(runnerTemp + path.sep));
  assert.ok(fs.existsSync(path.join(savedPaths[0], 'codecharter')), 'the saved dir holds the extracted CLI');
});

test('obtainCli_WhenTheArchiveHasNoExecutable_FailsAndLeavesNoStaging', async () => {
  tc.extractTar = async (_archive, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'README.txt'), 'no binary');
    return dest;
  };

  await assert.rejects(install(), /does not contain a codecharter executable/);

  assert.deepEqual(stagingLeftovers(), []);
  assert.equal(fs.existsSync(cliDir()), false, 'nothing is published');
});

test('obtainCli_WhenNoCompressorIsOnPath_SkipsTheActionsCacheAndStillPublishes', async () => {
  cache.isFeatureAvailable = () => true;
  io.which = async () => '';
  cache.restoreCache = async () => assert.fail('the cache is skipped without zstd or gzip');
  cache.saveCache = async () => assert.fail('the cache is skipped without zstd or gzip');

  const exe = await install();

  assert.equal(exe, path.join(cliDir(), 'codecharter'));
  assert.equal(downloads, 1);
  assert.match(warnings[0], /neither `zstd` nor `gzip` was found/);
  assert.equal(fs.existsSync(path.join(runnerTemp, 'codecharter-cli')), false, 'no transit dir without the cache');
});

test('obtainCli_WhenTheCacheRestoreThrows_DownloadsIntoACleanTransitDir', async () => {
  cache.isFeatureAvailable = () => true;
  io.which = async () => '/usr/bin/gzip';
  cache.restoreCache = async (paths) => {
    fs.writeFileSync(path.join(paths[0], 'partial.bin'), 'half a restore');
    throw new Error('cache service unavailable');
  };
  const savedPaths = [];
  cache.saveCache = async (paths) => savedPaths.push(paths[0]);

  const exe = await install();

  assert.equal(exe, path.join(cliDir(), 'codecharter'));
  assert.equal(downloads, 1);
  assert.equal(fs.existsSync(path.join(savedPaths[0], 'partial.bin')), false, 'a failed restore is cleared');
  assert.equal(fs.existsSync(path.join(cliDir(), 'partial.bin')), false);
});

test('obtainCli_WhenTheRenameKeepsFailingWithNothingInTheWay_WarnsWithTheErrorCode', async () => {
  // A virus scanner holding the fresh staging copy, for instance.
  fs.renameSync = (from) => {
    const err = new Error(`EBUSY: resource busy or locked, rename '${from}'`);
    err.code = 'EBUSY';
    throw err;
  };

  const exe = await install();

  assert.notEqual(path.dirname(exe), cliDir());
  assert.equal(fs.existsSync(cliDir()), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not be moved into the tool cache at .* \(EBUSY\)/);
  assert.doesNotMatch(warnings[0], /completion marker/);
});

// A process id no machine hands out, so its staging copy counts as abandoned.
const DEAD_PID = 2147483646;
const DAY_MS = 24 * 60 * 60 * 1000;

function plantLeftover(name, ageMs) {
  const dir = path.join(path.dirname(cliDir()), name);
  writeCliFiles(dir, 'leftover');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, when, when);
  return dir;
}

test('obtainCli_WhenKilledJobsLeftOldCopies_RemovesOnlyAbandonedOnesOfThisVersion', async () => {
  const oldStaging = plantLeftover(`${VERSION}.staging-${DEAD_PID}-aa11`, 2 * DAY_MS);
  const oldStale = plantLeftover(`${VERSION}.stale-${DEAD_PID}-bb22`, 2 * DAY_MS);
  const young = plantLeftover(`${VERSION}.staging-${DEAD_PID}-cc33`, 60 * 60 * 1000);
  const ownProcess = plantLeftover(`${VERSION}.staging-${process.pid}-dd44`, 2 * DAY_MS);
  const otherVersion = plantLeftover(`1.6.8.staging-${DEAD_PID}-ee55`, 2 * DAY_MS);
  const unrelated = plantLeftover(`${VERSION}.backup`, 2 * DAY_MS);

  await install();

  assert.equal(fs.existsSync(oldStaging), false, 'an abandoned staging copy is removed');
  assert.equal(fs.existsSync(oldStale), false, 'an abandoned moved-aside copy is removed');
  assert.equal(fs.existsSync(young), true, 'a copy younger than a day may still be in use');
  assert.equal(fs.existsSync(ownProcess), true, 'a copy of a running process may be in use');
  assert.equal(fs.existsSync(otherVersion), true, 'other versions are not touched');
  assert.equal(fs.existsSync(unrelated), true, 'folders of another shape are not touched');
  assert.ok(fs.existsSync(path.join(cliDir(), CLI_COMPLETE_MARKER)));
});

test('obtainCli_WhenAnAbandonedCopyIsStillInUse_LeavesItAndStillPublishes', async () => {
  const inUseLeftover = plantLeftover(`${VERSION}.staging-${DEAD_PID}-ff66`, 2 * DAY_MS);
  lockCopy(inUseLeftover);

  const exe = await install();

  assert.equal(exe, path.join(cliDir(), 'codecharter'));
  assert.equal(fs.existsSync(inUseLeftover), true);
});

test('obtainCli_WhenTheRunFallsBackToItsStagingCopy_NeverRemovesIt', async () => {
  writeCliFiles(cliDir(), 'old-action');
  lockCopy(cliDir());
  fs.renameSync = (from, to) => {
    if (isInUse(from)) throw eperm('rename', from);
    return saved.renameSync(from, to);
  };

  const exe = await install();
  // A day later the same run's copy is still its own: removal skips it by path.
  const staging = path.dirname(exe);
  const later = new Date(Date.now() - 2 * DAY_MS);
  fs.utimesSync(staging, later, later);
  await action.removeLeftoverCopies(cliDir(), staging);

  assert.equal(fs.existsSync(exe), true);
});

test('removeLeftoverCopies_WhenTheVersionsFolderIsMissing_DoesNothing', async () => {
  await action.removeLeftoverCopies(path.join(toolCache, 'absent', VERSION), null);
});
