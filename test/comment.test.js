'use strict';

// buildComment renders the sticky PR comment. The tests pin the zero-finding
// shortcut, the per-severity badges, category grouping/sorting, pipe escaping
// and the row-cap truncation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildComment, MAX_COMMENT_ROWS } from '../src/index.js';

const WS = path.resolve('/tmp', 'ws');
const baseOpts = {
  severityThreshold: 'info',
  repoFull: 'acme/widgets',
  sha: 'cafe1234',
  titleSuffix: '',
  failOn: 'error',
};

function violation(severity, category, ruleName, line = 1) {
  return {
    severity,
    category,
    ruleName,
    filePath: path.join(WS, 'src', 'File.cs'),
    lineNumber: line,
  };
}

test('buildComment: zero findings → single brightgreen badge line, no tables', () => {
  const md = buildComment({ violations: [] }, { total: 0, error: 0, warn: 0, info: 0 }, WS, baseOpts);
  assert.match(md, /## CodeGuard Analysis/);
  assert.match(md, /issues-0-brightgreen/);
  assert.ok(!md.includes('<details>'), 'no category sections when clean');
});

test('buildComment: titleSuffix is appended to the heading', () => {
  const md = buildComment({ violations: [] }, { total: 0, error: 0, warn: 0, info: 0 }, WS, {
    ...baseOpts,
    titleSuffix: 'samples/App.sln',
  });
  assert.match(md, /## CodeGuard Analysis — `samples\/App\.sln`/);
});

test('buildComment: only the present severities get a count badge', () => {
  const report = { violations: [violation('error', 'Cat', 'R1'), violation('info', 'Cat', 'R2')] };
  const counts = { total: 2, error: 1, warn: 0, info: 1 };
  const md = buildComment(report, counts, WS, baseOpts);
  assert.match(md, /errors-1-red/);
  assert.match(md, /info-1-blue/);
  assert.ok(!md.includes('warnings-'), 'no warnings badge when warn count is 0');
});

test('buildComment: categories are rendered, sorted, with a summary count', () => {
  const report = {
    violations: [violation('error', 'Zed', 'R1'), violation('warning', 'Alpha', 'R2')],
  };
  const counts = { total: 2, error: 1, warn: 1, info: 0 };
  const md = buildComment(report, counts, WS, baseOpts);
  assert.ok(md.indexOf('Alpha') < md.indexOf('Zed'), 'categories sorted alphabetically');
  assert.match(md, /<summary>Alpha \(1 warnings\)<\/summary>/);
  assert.match(md, /<summary>Zed \(1 errors\)<\/summary>/);
});

test('buildComment: missing category falls back to Uncategorized', () => {
  const report = { violations: [{ severity: 'info', ruleName: 'R', filePath: path.join(WS, 'a.cs'), lineNumber: 3 }] };
  const md = buildComment(report, { total: 1, error: 0, warn: 0, info: 1 }, WS, baseOpts);
  assert.match(md, /<summary>Uncategorized/);
});

test('buildComment: pipe characters in rule names are escaped for the table', () => {
  const report = { violations: [violation('error', 'Cat', 'Rule|With|Pipes')] };
  const md = buildComment(report, { total: 1, error: 1, warn: 0, info: 0 }, WS, baseOpts);
  assert.match(md, /Rule\\\|With\\\|Pipes/);
});

test('buildComment: backslashes are escaped before pipes (no broken/double escaping)', () => {
  const report = { violations: [violation('error', 'Cat', 'a\\b|c')] };
  const md = buildComment(report, { total: 1, error: 1, warn: 0, info: 0 }, WS, baseOpts);
  // backslash → \\, pipe → \| ; so "a\b|c" becomes "a\\b\|c"
  assert.ok(md.includes('a\\\\b\\|c'), 'backslash doubled, pipe escaped');
});

test('buildComment: rows within a category are sorted errors-first', () => {
  const report = {
    violations: [violation('info', 'Cat', 'InfoRule'), violation('error', 'Cat', 'ErrorRule')],
  };
  const md = buildComment(report, { total: 2, error: 1, warn: 0, info: 1 }, WS, baseOpts);
  assert.ok(md.indexOf('ErrorRule') < md.indexOf('InfoRule'), 'error row precedes info row');
});

test('buildComment: caps at MAX_COMMENT_ROWS and notes the truncation', () => {
  const violations = [];
  for (let i = 0; i < MAX_COMMENT_ROWS + 25; i++) {
    violations.push(violation('error', 'Cat', `Rule${i}`));
  }
  const counts = { total: violations.length, error: violations.length, warn: 0, info: 0 };
  const md = buildComment({ violations }, counts, WS, baseOpts);
  const rows = (md.match(/\| !\[error\]/g) || []).length;
  assert.equal(rows, MAX_COMMENT_ROWS, 'exactly the cap is rendered');
  assert.match(md, new RegExp(`Showing the first ${MAX_COMMENT_ROWS} findings`));
});

test('buildComment: truncation stops rendering further categories too', () => {
  const violations = [];
  // The cap must be reached *within* the first category ("AAA") for the outer
  // loop to skip the second ("ZZZ") entirely, so AAA exceeds the cap on its own.
  for (let i = 0; i < MAX_COMMENT_ROWS + 5; i++) violations.push(violation('error', 'AAA', `R${i}`));
  for (let i = 0; i < 10; i++) violations.push(violation('error', 'ZZZ', `Z${i}`));
  const counts = { total: violations.length, error: violations.length, warn: 0, info: 0 };
  const md = buildComment({ violations }, counts, WS, baseOpts);
  const rows = (md.match(/\| !\[error\]/g) || []).length;
  assert.equal(rows, MAX_COMMENT_ROWS);
  assert.ok(!md.includes('ZZZ'), 'the second category is not rendered once truncated');
  assert.match(md, new RegExp(`Showing the first ${MAX_COMMENT_ROWS} findings`));
});

test('buildComment: footer reflects the fail-on gate', () => {
  const report = { violations: [violation('error', 'Cat', 'R1')] };
  const md = buildComment(report, { total: 1, error: 1, warn: 0, info: 0 }, WS, { ...baseOpts, failOn: 'never' });
  assert.match(md, /does not fail the check/);
});
