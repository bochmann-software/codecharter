'use strict';

// Pure-helper coverage: severity mapping, badges, colours, footer/title/gate
// logic and the comment marker. These functions carry the action's decisions,
// so every branch and the odd-input edge cases are exercised here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  commentMarker,
  resolvePlatform,
  tally,
  severityLabel,
  displayPath,
  minSeverityColor,
  severityBadge,
  locationLink,
  severityRank,
  failOnColor,
  failOnBadge,
  footerLine,
  conclusionFor,
  titleFor,
  PLATFORMS,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// commentMarker
// ---------------------------------------------------------------------------

test('commentMarker: deterministic 12-hex tag in the expected envelope', () => {
  const m = commentMarker('workflow / job / sln');
  assert.match(m, /^<!-- codeguard-analysis:[0-9a-f]{12} -->$/);
  assert.equal(commentMarker('workflow / job / sln'), m, 'same input → same marker');
});

test('commentMarker: different discriminators yield different markers', () => {
  assert.notEqual(commentMarker('a'), commentMarker('b'));
});

test('commentMarker: empty/undefined fall back to the "default" hash', () => {
  const def = commentMarker('default');
  assert.equal(commentMarker(''), def);
  assert.equal(commentMarker(undefined), def);
  assert.equal(commentMarker(null), def);
});

// ---------------------------------------------------------------------------
// resolvePlatform
// ---------------------------------------------------------------------------

function withProcess(platform, arch, fn) {
  const op = Object.getOwnPropertyDescriptor(process, 'platform');
  const oa = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', op);
    Object.defineProperty(process, 'arch', oa);
  }
}

test('resolvePlatform: maps every supported platform:arch pair', () => {
  for (const [key, token] of Object.entries(PLATFORMS)) {
    const [platform, arch] = key.split(':');
    assert.equal(withProcess(platform, arch, resolvePlatform), token, key);
  }
});

test('resolvePlatform: unsupported pair throws and lists the supported tokens', () => {
  assert.throws(
    () => withProcess('linux', 'arm64', resolvePlatform),
    (err) => {
      assert.match(err.message, /not available for linux\/arm64/);
      assert.match(err.message, /win-x64/);
      assert.match(err.message, /osx-arm64/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// tally
// ---------------------------------------------------------------------------

test('tally: missing/empty violations array → all zeros', () => {
  assert.deepEqual(tally({}), { total: 0, error: 0, warn: 0, info: 0 });
  assert.deepEqual(tally({ violations: [] }), { total: 0, error: 0, warn: 0, info: 0 });
});

test('tally: counts by normalized severity, "warning" and "warn" both warn', () => {
  const report = {
    violations: [
      { severity: 'Error' },
      { severity: 'error' },
      { severity: 'warning' },
      { severity: 'WARN' },
      { severity: 'info' },
    ],
  };
  assert.deepEqual(tally(report), { total: 5, error: 2, warn: 2, info: 1 });
});

test('tally: unknown/missing severity is bucketed as info', () => {
  const report = { violations: [{ severity: 'fatal' }, {}, { severity: '' }] };
  assert.deepEqual(tally(report), { total: 3, error: 0, warn: 0, info: 3 });
});

// ---------------------------------------------------------------------------
// severityLabel / severityRank
// ---------------------------------------------------------------------------

test('severityLabel: normalizes all known forms and defaults to info', () => {
  assert.equal(severityLabel('error'), 'error');
  assert.equal(severityLabel('ERROR'), 'error');
  assert.equal(severityLabel('warning'), 'warn');
  assert.equal(severityLabel('warn'), 'warn');
  assert.equal(severityLabel('info'), 'info');
  assert.equal(severityLabel('whatever'), 'info');
  assert.equal(severityLabel(''), 'info');
  assert.equal(severityLabel(undefined), 'info');
});

test('severityRank: error<warn<info, unknown ranks as info', () => {
  assert.equal(severityRank('error'), 0);
  assert.equal(severityRank('warning'), 1);
  assert.equal(severityRank('info'), 2);
  assert.equal(severityRank('mystery'), 2);
  assert.ok(severityRank('error') < severityRank('warn'));
  assert.ok(severityRank('warn') < severityRank('info'));
});

// ---------------------------------------------------------------------------
// displayPath
// ---------------------------------------------------------------------------

test('displayPath: empty input → empty string', () => {
  assert.equal(displayPath('', '/ws'), '');
  assert.equal(displayPath(undefined, '/ws'), '');
});

test('displayPath: absolute path inside workspace → relative, forward-slashed', () => {
  const ws = path.resolve('/tmp', 'ws');
  const file = path.join(ws, 'src', 'a.cs');
  assert.equal(displayPath(file, ws), 'src/a.cs');
});

test('displayPath: absolute path outside workspace keeps it but normalizes slashes', () => {
  const ws = path.resolve('/tmp', 'ws');
  const outside = path.resolve('/tmp', 'other', 'b.cs');
  const result = displayPath(outside, ws);
  assert.ok(result.includes('b.cs'));
  assert.ok(!result.includes('\\'), 'no backslashes remain');
});

test('displayPath: relative input strips ./ and leading slashes, flips slashes', () => {
  assert.equal(displayPath('./src/a.cs', '/ws'), 'src/a.cs');
  assert.equal(displayPath('src\\nested\\a.cs', '/ws'), 'src/nested/a.cs');
});

// ---------------------------------------------------------------------------
// colours and badges
// ---------------------------------------------------------------------------

test('minSeverityColor: maps thresholds and defaults to lightgrey', () => {
  assert.equal(minSeverityColor('error'), 'red');
  assert.equal(minSeverityColor('warn'), 'yellow');
  assert.equal(minSeverityColor('warning'), 'yellow');
  assert.equal(minSeverityColor('info'), 'blue');
  assert.equal(minSeverityColor('never'), 'lightgrey');
  assert.equal(minSeverityColor(''), 'lightgrey');
});

test('failOnColor: maps levels and defaults (never) to lightgrey', () => {
  assert.equal(failOnColor('error'), 'red');
  assert.equal(failOnColor('warn'), 'yellow');
  assert.equal(failOnColor('warning'), 'yellow');
  assert.equal(failOnColor('info'), 'blue');
  assert.equal(failOnColor('never'), 'lightgrey');
  assert.equal(failOnColor('bogus'), 'lightgrey');
});

test('severityBadge: distinct badge per severity, default info', () => {
  assert.match(severityBadge('error'), /ERROR-d9534f/);
  assert.match(severityBadge('warning'), /WARN-f0ad4e/);
  assert.match(severityBadge('warn'), /WARN-f0ad4e/);
  assert.match(severityBadge('info'), /INFO-5bc0de/);
  assert.match(severityBadge('???'), /INFO-5bc0de/);
});

test('failOnBadge: defaults to never and url-encodes the value', () => {
  assert.match(failOnBadge(''), /fail--on-never-lightgrey/);
  assert.match(failOnBadge('error'), /fail--on-error-red/);
  assert.match(failOnBadge('warn'), /fail--on-warn-yellow/);
});

// ---------------------------------------------------------------------------
// locationLink
// ---------------------------------------------------------------------------

const REPO = 'acme/widgets';
const SHA = 'deadbeef';

test('locationLink: no filePath → dash', () => {
  assert.equal(locationLink({}, '/ws', REPO, SHA), '-');
});

test('locationLink: with line number links to the blob anchor', () => {
  const ws = path.resolve('/tmp', 'ws');
  const v = { filePath: path.join(ws, 'src', 'A.cs'), lineNumber: 42 };
  const link = locationLink(v, ws, REPO, SHA);
  assert.equal(link, `[A.cs:42](https://github.com/${REPO}/blob/${SHA}/src/A.cs#L42)`);
});

test('locationLink: without line number links the file only', () => {
  const ws = path.resolve('/tmp', 'ws');
  const v = { filePath: path.join(ws, 'src', 'A.cs') };
  const link = locationLink(v, ws, REPO, SHA);
  assert.equal(link, `[A.cs](https://github.com/${REPO}/blob/${SHA}/src/A.cs)`);
});

// ---------------------------------------------------------------------------
// footerLine
// ---------------------------------------------------------------------------

const counts = (error, warn, info) => ({ total: error + warn + info, error, warn, info });

test('footerLine: never → reporting-only note regardless of counts', () => {
  assert.match(footerLine('never', counts(5, 5, 5)), /does not fail the check/);
});

test('footerLine: error gate counts only errors as blocking', () => {
  assert.match(footerLine('error', counts(2, 9, 9)), /Fix \*\*2\*\* finding/);
  assert.match(footerLine('error', counts(0, 9, 9)), /No findings at or above `error`/);
});

test('footerLine: warn gate sums errors+warnings, normalizes label', () => {
  assert.match(footerLine('warn', counts(1, 2, 9)), /Fix \*\*3\*\* finding/);
  assert.match(footerLine('warning', counts(1, 2, 9)), /at or above `warn`/);
});

test('footerLine: info gate counts everything', () => {
  assert.match(footerLine('info', counts(1, 1, 1)), /Fix \*\*3\*\* finding/);
  assert.match(footerLine('info', counts(0, 0, 0)), /No findings at or above `info`/);
});

// ---------------------------------------------------------------------------
// conclusionFor
// ---------------------------------------------------------------------------

test('conclusionFor: never is always neutral', () => {
  assert.equal(conclusionFor('never', counts(9, 9, 9)), 'neutral');
});

test('conclusionFor: error gate fails only on errors', () => {
  assert.equal(conclusionFor('error', counts(1, 0, 0)), 'failure');
  assert.equal(conclusionFor('error', counts(0, 9, 9)), 'success');
});

test('conclusionFor: warn gate fails on errors or warnings', () => {
  assert.equal(conclusionFor('warn', counts(0, 1, 0)), 'failure');
  assert.equal(conclusionFor('warning', counts(0, 0, 9)), 'success');
});

test('conclusionFor: info gate fails on any finding', () => {
  assert.equal(conclusionFor('info', counts(0, 0, 1)), 'failure');
  assert.equal(conclusionFor('info', counts(0, 0, 0)), 'success');
});

// ---------------------------------------------------------------------------
// titleFor
// ---------------------------------------------------------------------------

test('titleFor: zero findings → "No findings"', () => {
  assert.equal(titleFor(counts(0, 0, 0)), 'No findings');
});

test('titleFor: summarizes the counts', () => {
  assert.equal(titleFor(counts(1, 2, 3)), '1 error, 2 warning, 3 info');
});
