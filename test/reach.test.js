'use strict';

// reachFromReport/formatRuleSources/formatDrift parse the CLI's run.reach /
// run.ruleSources (CLI >= 1.6.4). Exercised against trimmed copies of real
// `codecharter analyze --output json` reports (see test/fixtures), not
// hand-guessed shapes, so a field rename would show up here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reachFromReport, formatRuleSources, formatDrift, buildComment, tally } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));
}

const healthy = () => fixture('reach-profile-plus-rules-dir.json');
const drifted = () => fixture('reach-pin-drift.json');

// ---------------------------------------------------------------------------
// reachFromReport
// ---------------------------------------------------------------------------

test('reachFromReport: a healthy run (profile + rules directory) reads the real field names', () => {
  const reach = reachFromReport(healthy());
  assert.equal(reach.isInconclusive, false);
  assert.deepEqual(reach.reasons, []);
  assert.equal(reach.configured, 247);
  assert.equal(reach.resolved, 254);
  assert.equal(reach.evaluated, 254);
  assert.deepEqual(reach.unresolvedSources, []);
  assert.deepEqual(reach.drift, []);
  assert.equal(reach.ruleSources.length, 2);
  assert.equal(reach.ruleSources[0].identity, 'codeguard/csharp-all@1.2.0');
  assert.equal(reach.ruleSources[1].identity, '.codecharter/rules');
});

test('reachFromReport: a pin-drift run reads isInconclusive, reasons and drift', () => {
  const reach = reachFromReport(drifted());
  assert.equal(reach.isInconclusive, true);
  assert.deepEqual(reach.reasons, ['config-lock-drift']);
  assert.equal(reach.drift.length, 1);
  assert.equal(reach.drift[0].kind, 'version-not-satisfied');
  assert.equal(reach.drift[0].profile, 'codeguard/csharp-all');
  assert.equal(reach.drift[0].requestedSpec, '9.9.9');
  assert.equal(reach.drift[0].lockedVersion, '1.2.0');
});

test('reachFromReport: a report with no run.reach (older CLI) yields null', () => {
  assert.equal(reachFromReport({ violations: [] }), null);
  assert.equal(reachFromReport({ run: {} }), null);
});

// ---------------------------------------------------------------------------
// formatRuleSources
// ---------------------------------------------------------------------------

test('formatRuleSources: one entry per source, resolved count + identity', () => {
  const reach = reachFromReport(healthy());
  assert.equal(formatRuleSources(reach.ruleSources), '247 from codeguard/csharp-all@1.2.0, 7 from .codecharter/rules');
});

test('formatRuleSources: an unresolved source is called out instead of shown with a count', () => {
  const text = formatRuleSources([
    { identity: 'my-org/security@2.0.1', isResolved: false },
    { identity: '.codecharter/rules', resolvedCount: 5, isResolved: true },
  ]);
  assert.equal(text, 'my-org/security@2.0.1 (unresolved), 5 from .codecharter/rules');
});

test('formatRuleSources: empty/missing → empty string', () => {
  assert.equal(formatRuleSources([]), '');
  assert.equal(formatRuleSources(undefined), '');
});

// ---------------------------------------------------------------------------
// formatDrift
// ---------------------------------------------------------------------------

test('formatDrift: version-not-satisfied renders profile, requested spec and locked version', () => {
  const reach = reachFromReport(drifted());
  assert.deepEqual(formatDrift(reach.drift), ['codeguard/csharp-all: config.yml requests 9.9.9, the lock has 1.2.0']);
});

test('formatDrift: an unknown kind still renders generically from its own fields', () => {
  assert.deepEqual(formatDrift([{ kind: 'something-else', foo: 'bar' }]), ['something-else (foo: bar)']);
});

test('formatDrift: empty/missing → empty array', () => {
  assert.deepEqual(formatDrift([]), []);
  assert.deepEqual(formatDrift(undefined), []);
});

// ---------------------------------------------------------------------------
// buildComment against the real fixtures
// ---------------------------------------------------------------------------

const baseOpts = {
  severityThreshold: 'info',
  repoFull: 'acme/widgets',
  sha: 'cafe1234',
  titleSuffix: '',
  failOn: 'never',
};

test('buildComment: a healthy run lists rule sources with their resolved counts', () => {
  const report = healthy();
  const md = buildComment(report, tally(report), '/workspace', baseOpts);
  assert.match(
    md,
    /_Reach: 254 rule\(s\) evaluated, 247 configured — 247 from codeguard\/csharp-all@1\.2\.0, 7 from \.codecharter\/rules\._/
  );
});

test('buildComment: an inconclusive run leads with its own callout, reasons and drift', () => {
  const report = drifted();
  const md = buildComment(report, tally(report), '/workspace', baseOpts);
  assert.match(md, /\*\*Inconclusive run\*\* — config-lock-drift\./);
  assert.match(md, /- codeguard\/csharp-all: config\.yml requests 9\.9\.9, the lock has 1\.2\.0/);
});
