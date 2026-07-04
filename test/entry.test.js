'use strict';

// The entry-point guard decides whether `run()` starts. It must recognize the
// module as the entry point even when the runner reaches it through a
// junction/symlink or a differently-cased drive letter (some self-hosted
// Windows runners), otherwise the action silently no-ops and passes without
// analyzing anything. These run against real temp files and symlinks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isMainModule } from '../src/index.js';

function tmproot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

test('isMainModule: no entry arg (e.g. REPL) → false', () => {
  assert.equal(isMainModule('file:///whatever.js', undefined), false);
  assert.equal(isMainModule('file:///whatever.js', ''), false);
});

test('isMainModule: exact URL match → true (common Linux/macOS case)', () => {
  const root = tmproot('cg-entry-exact-');
  const file = path.join(root, 'index.js');
  fs.writeFileSync(file, '');
  assert.equal(isMainModule(pathToFileURL(file).href, file), true);
});

test('isMainModule: different file → false (imported from a test)', () => {
  const root = tmproot('cg-entry-diff-');
  const self = path.join(root, 'index.js');
  const other = path.join(root, 'test-runner.js');
  fs.writeFileSync(self, '');
  fs.writeFileSync(other, '');
  assert.equal(isMainModule(pathToFileURL(self).href, other), false);
});

test('isMainModule: entry reached via a symlinked directory still matches', () => {
  const root = tmproot('cg-entry-link-');
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  const file = path.join(real, 'index.js');
  fs.writeFileSync(file, '');

  // Mirror the runner's junction: the same file is reachable through a second
  // path. `import.meta.url` is the realpath; `process.argv[1]` the linked path.
  const link = path.join(root, 'linked');
  try {
    fs.symlinkSync(real, link, 'junction');
  } catch {
    // Creating symlinks can require privileges on some Windows setups; skip
    // rather than fail the suite there.
    return;
  }
  const viaLink = path.join(link, 'index.js');
  assert.notEqual(pathToFileURL(file).href, pathToFileURL(viaLink).href, 'paths differ before resolution');
  assert.equal(isMainModule(pathToFileURL(file).href, viaLink), true);
});

test('isMainModule: drive-letter case difference matches on Windows', { skip: process.platform !== 'win32' }, () => {
  const root = tmproot('cg-entry-case-');
  const file = path.join(root, 'index.js');
  fs.writeFileSync(file, '');
  // Same path, opposite drive-letter case — realpath keeps the case, so the
  // Windows branch must compare case-insensitively.
  const flipped =
    file[0] === file[0].toUpperCase() ? file[0].toLowerCase() + file.slice(1) : file[0].toUpperCase() + file.slice(1);
  assert.equal(isMainModule(pathToFileURL(file).href, flipped), true);
});
