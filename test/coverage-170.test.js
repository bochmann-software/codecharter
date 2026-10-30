'use strict';

// Coverage mode against real `codecharter coverage` reports of CLI 1.7.0, run
// on a one-library, one-xUnit-project sample (absolute paths rewritten to a
// runner workspace):
//   coverage-1.7.0-below.json           --min-coverage 100, one method untested (exit 1)
//   coverage-1.7.0-uninstrumented.json  --min-coverage 50, the library built with
//                                       <DebugType>none</DebugType> (exit 2)
// 1.7.0 adds `uninstrumentedModules`: coverlet did not instrument a module, so
// the CLI fails the gate closed with exit code 2 although every test passed and
// the measured percentage (over zero lines) reads 100.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  coverageSummary,
  uninstrumentedModules,
  buildCoverageComment,
  coverageFooterLine,
  coverageTitle,
} from '../src/index.js';

const WORKSPACE = '/home/runner/work/sample/sample';
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));
const OPTS = { repoFull: 'acme/app', sha: 'abc', failOnThreshold: true };

test('coverageSummary_WhenGivenARealCli170BelowReport_ReadsTheSameFieldsAsBefore', () => {
  const summary = coverageSummary(fixture('coverage-1.7.0-below.json'));
  assert.equal(summary.total, 6);
  assert.equal(summary.covered, 3);
  assert.equal(summary.percent, 50);
  assert.equal(summary.required, 100);
  assert.equal(summary.source, 'cli-flag');
  assert.equal(summary.met, false);
  assert.equal(summary.diff, null);
  assert.equal(summary.regions.length, 1);
  assert.equal(summary.regions[0].relativeFile, 'src/Lib/Calc.cs');
  assert.deepEqual(summary.testCounts, { total: 1, passed: 1, failed: 0, skipped: 0 });
  assert.deepEqual(summary.uninstrumented, []);
});

test('coverageSummary_WhenAModuleWasNotInstrumented_ListsIt', () => {
  const summary = coverageSummary(fixture('coverage-1.7.0-uninstrumented.json'));
  assert.deepEqual(summary.uninstrumented, [
    { module: 'Lib', projectFile: `${WORKSPACE}/src/Lib/Lib.csproj`, reason: '' },
  ]);
});

test('coverageSummary_WhenTheReportPredatesCli170_HasNoUninstrumentedModules', () => {
  assert.deepEqual(coverageSummary(fixture('coverage-diff-below.json')).uninstrumented, []);
  assert.deepEqual(coverageSummary(null).uninstrumented, []);
});

test('uninstrumentedModules_WhenEntriesAreMalformed_KeepsOnlyNamedModules', () => {
  const modules = uninstrumentedModules({
    uninstrumentedModules: [null, 'Lib', { module: 5 }, { module: 'App', projectFile: 3, reason: 'boom' }],
  });
  assert.deepEqual(modules, [{ module: 'App', projectFile: '', reason: 'boom' }]);
  assert.deepEqual(uninstrumentedModules({ uninstrumentedModules: 'Lib' }), []);
});

test('buildCoverageComment_WhenAModuleWasNotInstrumented_NamesItAndTheFailClosedGate', () => {
  const summary = coverageSummary(fixture('coverage-1.7.0-uninstrumented.json'));
  const md = buildCoverageComment(summary, WORKSPACE, { ...OPTS, exitCode: 2 });
  assert.match(md, /### Modules not measured \(1\)/);
  assert.match(md, /\| Lib \| src\/Lib\/Lib\.csproj \| — \|/);
  assert.match(md, /failed closed because modules were not instrumented/);
  assert.doesNotMatch(md, /Cover the regions above/);
});

test('buildCoverageComment_WhenEveryModuleWasMeasured_HasNoModulesSection', () => {
  const summary = coverageSummary(fixture('coverage-1.7.0-below.json'));
  const md = buildCoverageComment(summary, WORKSPACE, { ...OPTS, exitCode: 1 });
  assert.doesNotMatch(md, /Modules not measured/);
});

test('coverageFooterLine_WhenAModuleWasNotInstrumented_IgnoresFailOnThreshold', () => {
  const summary = coverageSummary(fixture('coverage-1.7.0-uninstrumented.json'));
  assert.match(coverageFooterLine(summary, false), /`fail-on-threshold` does not soften this/);
});

test('coverageTitle_WhenAModuleWasNotInstrumented_SaysCoverageIsIncomplete', () => {
  const summary = coverageSummary(fixture('coverage-1.7.0-uninstrumented.json'));
  assert.equal(coverageTitle(2, summary), 'Coverage incomplete: 1 module(s) not instrumented');
  const failedTests = coverageSummary(fixture('coverage-1.7.0-below.json'));
  assert.equal(coverageTitle(2, failedTests), 'Tests failed or coverage was incomplete');
});
