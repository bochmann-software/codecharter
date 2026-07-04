'use strict';

// writeSummary appends the report to the job summary. It is best-effort: a
// failure (e.g. GITHUB_STEP_SUMMARY not set) must be swallowed, never thrown.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { core } from '../src/deps.js';
import { writeSummary } from '../src/index.js';

let saved;
let debugs;

beforeEach(() => {
  saved = { summary: core.summary, debug: core.debug };
  debugs = [];
  core.debug = (m) => debugs.push(m);
});

afterEach(() => {
  // core.summary is a getter-backed singleton; restore the original reference.
  Object.defineProperty(core, 'summary', { value: saved.summary, configurable: true, writable: true });
  core.debug = saved.debug;
});

test('writeSummary: writes the markdown via the summary chain', async () => {
  let written;
  Object.defineProperty(core, 'summary', {
    configurable: true,
    writable: true,
    value: {
      addRaw(md) {
        written = md;
        return this;
      },
      async write() {
        return this;
      },
    },
  });
  await writeSummary('# report');
  assert.equal(written, '# report');
  assert.equal(debugs.length, 0);
});

test('writeSummary: a write failure is swallowed and logged at debug', async () => {
  Object.defineProperty(core, 'summary', {
    configurable: true,
    writable: true,
    value: {
      addRaw() {
        return this;
      },
      async write() {
        throw new Error('GITHUB_STEP_SUMMARY not set');
      },
    },
  });
  await assert.doesNotReject(writeSummary('# report'));
  assert.ok(debugs.some((m) => /Could not write job summary/.test(m)));
});
