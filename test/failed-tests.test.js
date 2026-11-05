'use strict';

// The "Failed tests" section of the coverage summary (job summary, PR comment
// and check-run output share one body): which tests it lists, in what order,
// how report text is kept from rendering as Markdown or HTML, and how it
// shrinks when the assembled report would exceed GitHub's size limit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  boundFailedTestDetail,
  buildCoverageComment,
  codeBlock,
  coverageSummary,
  failedTestLines,
  MAX_COMMENT_CHARS,
  MAX_FAILED_TESTS_SHOWN,
} from '../src/index.js';

const WORKSPACE = '/repo';
const OPTS = { repoFull: 'acme/app', sha: 'abc', failOnThreshold: true, exitCode: 2 };

/** A failing project entry as the CLI (>= 1.7.0) writes it. */
function failing(name, failedTests, extra = {}) {
  return {
    project: name,
    exitCode: 1,
    succeeded: false,
    failureReason: 'tests failed (exit code 1)',
    total: 5,
    passed: 5 - failedTests.length,
    failed: failedTests.length,
    skipped: 0,
    failedTests,
    ...extra,
  };
}

/** A passing project entry. */
function passing(name) {
  return { project: name, exitCode: 0, succeeded: true, total: 3, passed: 3, failed: 0, skipped: 0, failedTests: [] };
}

/** A failed test with the given detail. */
function failedTest(name, message = 'Assert.Equal() Failure\nExpected: 1\nActual:   2', stackTrace = 'at A.B()') {
  return { name, message, stackTrace };
}

/** The rendered comment for a report whose only variable part is its test projects. */
function commentFor(testResults) {
  const report = {
    summary: {
      totalLines: 10,
      coveredLines: 10,
      percent: 100,
      minimumRequiredPercent: 100,
      hasMetThreshold: true,
      minimumRequiredPercentSource: 'config',
    },
    testResults,
    uncoveredRegions: [],
  };
  return buildCoverageComment(coverageSummary(report), WORKSPACE, OPTS);
}

test('failedTestLines: no failed test anywhere renders nothing', () => {
  assert.deepEqual(failedTestLines([passing('A.Tests')]), []);
  assert.deepEqual(failedTestLines([]), []);
  assert.deepEqual(failedTestLines(undefined), []);
  assert.deepEqual(failedTestLines([null, 'nope', { project: 'Old.Tests', succeeded: false, exitCode: 1 }]), []);
});

test('failedTestLines: lists each failed test with its message and stack trace', () => {
  const md = failedTestLines([failing('A.Tests', [failedTest('A.Tests.Fails')])]).join('\n');

  assert.match(md, /^### Failed tests$/m);
  assert.match(md, /^\*\*A\.Tests\*\*$/m);
  assert.match(md, /^- ❌ A\.Tests\.Fails$/m);
  assert.match(md, /<details><summary>Message and stack trace<\/summary>/);
  assert.match(md, /```text\nAssert\.Equal\(\) Failure\nExpected: 1\nActual: {3}2\n\nat A\.B\(\)\n```/);
});

test('failedTestLines: failing projects follow the table order, by name', () => {
  const md = failedTestLines([
    failing('Zeta.Tests', [failedTest('Zeta.Fails')]),
    passing('Alpha.Tests'),
    failing('Beta.Tests', [failedTest('Beta.Fails')]),
  ]).join('\n');

  assert.ok(md.indexOf('**Beta.Tests**') < md.indexOf('**Zeta.Tests**'));
  assert.doesNotMatch(md, /Alpha/, 'a passing project has no failed tests to list');
});

test('failedTestLines: report text cannot render as Markdown, HTML or a mention', () => {
  const md = failedTestLines([
    failing('Fork.Tests', [
      failedTest(
        'Fork.**Bold**<img src=x>@octocat\n## Forged',
        'closes ``` the fence?\n</details><script>alert(1)</script> @octocat'
      ),
    ]),
  ]).join('\n');

  assert.match(
    md,
    /^- ❌ Fork\.\\\*\\\*Bold\\\*\\\*\\<img src=x\\>@\u200Boctocat \\#\\# Forged$/m,
    'the name is escaped on one line'
  );
  assert.doesNotMatch(md, /^## Forged/m);
  assert.match(md, /^````text$/m, 'the fence is longer than any backtick run in the text');
  assert.match(
    md,
    /^<\/details><script>alert\(1\)<\/script> @octocat$/m,
    'inside the code block the text stays literal'
  );
});

test('failedTestLines: a test without detail is listed by name only', () => {
  const md = failedTestLines([failing('A.Tests', [{ name: '', message: '', stackTrace: '' }])]).join('\n');
  assert.match(md, /^- ❌ \(unnamed test\)$/m);
  assert.doesNotMatch(md, /<details>/);
});

test('failedTestLines: messages mode drops the stack trace, names mode the detail', () => {
  const projects = [failing('A.Tests', [failedTest('A.Fails', 'boom', 'at Secret.Frame()')])];

  const messages = failedTestLines(projects, 'messages').join('\n');
  assert.match(messages, /<summary>Message<\/summary>/);
  assert.match(messages, /boom/);
  assert.doesNotMatch(messages, /Secret\.Frame/);

  const names = failedTestLines(projects, 'names').join('\n');
  assert.match(names, /^- ❌ A\.Fails$/m);
  assert.doesNotMatch(names, /boom|<details>/);

  assert.deepEqual(failedTestLines(projects, 'none'), []);
});

test('failedTestLines: lists at most MAX_FAILED_TESTS_SHOWN tests and counts the rest', () => {
  const many = Array.from({ length: 15 }, (_, i) => failedTest(`T${i}`));
  const md = failedTestLines([
    failing('A.Tests', many),
    failing('B.Tests', many),
    failing('C.Tests', many.slice(0, 2), { failed: 30 }),
  ]).join('\n');

  assert.equal((md.match(/^- ❌ /gm) || []).length, MAX_FAILED_TESTS_SHOWN);
  assert.doesNotMatch(md, /\*\*C\.Tests\*\*/, 'a project with no room left gets no heading');
  assert.match(
    md,
    /_… 40 more failed test\(s\) not shown; the job log lists them\._/,
    '10 of B, and C reports 30 failures'
  );
});

test('boundFailedTestDetail: cuts long text and says so', () => {
  assert.equal(boundFailedTestDetail(undefined), '');
  assert.equal(boundFailedTestDetail('  a\r\nb  '), 'a\nb');

  const manyLines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const cutLines = boundFailedTestDetail(manyLines).split('\n');
  assert.equal(cutLines.length, 21);
  assert.equal(cutLines.at(-1), '… (truncated)');

  const long = boundFailedTestDetail('x'.repeat(5000));
  assert.equal(long, `${'x'.repeat(2000)}\n… (truncated)`);
});

test('codeBlock: uses three backticks unless the text holds a longer run', () => {
  assert.deepEqual(codeBlock('plain'), ['```text', 'plain', '```']);
  assert.deepEqual(codeBlock('a ```` b'), ['`````text', 'a ```` b', '`````']);
});

test('buildCoverageComment: the failed tests follow the test table', () => {
  const md = commentFor([failing('A.Tests', [failedTest('A.Fails')]), passing('B.Tests')]);

  assert.ok(md.indexOf('| Project |') < md.indexOf('### Failed tests'));
  assert.match(md, /^- ❌ A\.Fails$/m);
});

test('buildCoverageComment: oversized stack traces go before the messages and the rows', () => {
  const bulky = (i) => failedTest(`T${i}`, 'm'.repeat(1500), 's'.repeat(1900));
  const md = commentFor([
    failing(
      'A.Tests',
      Array.from({ length: 20 }, (_, i) => bulky(i))
    ),
    passing('B.Tests'),
  ]);

  assert.ok(md.length <= MAX_COMMENT_CHARS, `expected the report to fit the budget, got ${md.length}`);
  assert.match(md, /<summary>Message<\/summary>/, 'the messages survive');
  assert.doesNotMatch(md, /sss/, 'the stack traces were dropped');
  assert.match(md, /^\| B\.Tests \|/m, 'the passing row survives');
});

test('buildCoverageComment: when even the messages do not fit, the names remain', () => {
  const bulky = (p, i) => failedTest(`P${p}.T${i}`, 'm'.repeat(2000), 's'.repeat(2000));
  const projects = Array.from({ length: 400 }, (_, p) =>
    failing(`Contoso.Enterprise.Platform.Services.Module${String(p).padStart(4, '0')}.Tests`, [bulky(p, 0)])
  );
  const md = commentFor(projects);

  assert.ok(md.length <= MAX_COMMENT_CHARS, `expected the report to fit the budget, got ${md.length}`);
  assert.match(md, /^- ❌ P0\.T0$/m, 'the failed test names survive');
  assert.doesNotMatch(md, /<details>/);
});
