'use strict';

// escapeInline: report- and log-derived text (exception messages, project
// names, rule names, file paths) must render literally in the PR comment and
// the check summary, and must never mention anyone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as action from '../src/index.js';

const { escapeInline, buildComment, tally, buildCoverageComment, coverageSummary } = action;
const ZWSP = '​';

test('escapeInline_WhenTextHasMarkdownOrHtml_EscapesEachSpecialCharacter', () => {
  assert.equal(
    escapeInline('List`1[System.String] <T> my_var *x* #1 a|b ~s~ &amp; back\\slash'),
    'List\\`1\\[System.String\\] \\<T\\> my\\_var \\*x\\* \\#1 a\\|b \\~s\\~ \\&amp; back\\\\slash'
  );
});

test('escapeInline_WhenTextMentionsSomeone_BreaksTheMention', () => {
  assert.equal(escapeInline('ping @octocat and (@team)'), `ping @${ZWSP}octocat and (@${ZWSP}team)`);
  assert.equal(escapeInline('@start'), `@${ZWSP}start`);
});

test('escapeInline_WhenAnAtSignIsPartOfAWord_LeavesIt', () => {
  assert.equal(
    escapeInline('codeguard/csharp-all@1.2.0 dev@example.com'),
    'codeguard/csharp-all@1.2.0 dev@example.com'
  );
});

test('escapeInline_WhenTextSpansLines_KeepsOneLine', () => {
  assert.equal(escapeInline('a\r\n## b\nc'), 'a \\#\\# b c');
  assert.equal(escapeInline(undefined), '');
});

test('buildComment_WhenAnInconclusiveRunCarriesHostileDetail_RendersItLiterally', () => {
  const report = {
    violations: [],
    run: {
      ruleSources: [{ identity: '@evil/rules', isResolved: false, unresolvedReason: 'see <script>' }],
      reach: {
        isInconclusive: true,
        inconclusiveReasons: ['rule-faulted'],
        unresolvedSources: ['@evil/rules'],
        coreLibraryUnresolvedProjects: ['My_App'],
        drift: [{ kind: 'version-not-satisfied', profile: 'a*b', requestedSpec: '1', lockedVersion: '2' }],
        ruleFaults: [{ ruleId: 'r', kind: 'rule-aborted', message: 'List`1 failed for @admin <img src=x>' }],
      },
    },
  };
  const md = buildComment(report, tally(report), '/repo', {
    severityThreshold: 'info',
    repoFull: 'acme/app',
    sha: 'abc',
    failOn: 'error',
  });
  assert.ok(md.includes(`- Rule r threw and reported nothing: List\\\`1 failed for @${ZWSP}admin \\<img src=x\\>`), md);
  assert.ok(md.includes(`- Unresolved: @${ZWSP}evil/rules (see \\<script\\>)`), md);
  assert.ok(md.includes('- Core library not resolved for: My\\_App'), md);
  assert.ok(md.includes('- a\\*b: config.yml requests 1, the lock has 2'), md);
  assert.equal(md.includes('@admin'), false, 'the mention is broken');
});

test('buildComment_WhenAConclusiveRunNamesSources_EscapesTheReachLineAndLinkText', () => {
  const report = {
    violations: [{ severity: 'info', ruleName: 'r', filePath: '/repo/src/my_[x].cs', lineNumber: 2 }],
    run: {
      ruleSources: [{ identity: 'rules_dir', resolvedCount: 1, isResolved: true }],
      reach: { evaluated: 1, isInconclusive: false },
    },
  };
  const md = buildComment(report, tally(report), '/repo', {
    severityThreshold: 'info',
    repoFull: 'acme/app',
    sha: 'abc',
    failOn: 'error',
  });
  assert.ok(md.includes('_Reach: 1 rule(s) evaluated — 1 from rules\\_dir._'), md);
  assert.ok(md.includes('[my\\_\\[x\\].cs:2](https://github.com/acme/app/blob/abc/src/my_[x].cs#L2)'), md);
});

test('buildCoverageComment_WhenFileNamesHaveMarkdown_EscapesSummaryAndLinkText', () => {
  const summary = coverageSummary({
    summary: { totalLines: 2, coveredLines: 1, percent: 50, minimumRequiredPercent: 100, hasMetThreshold: false },
    uncoveredRegions: [{ relativeFile: 'src/a_b.cs', method: 'M<T>', lines: [3] }],
  });
  const md = buildCoverageComment(summary, '/repo', {
    repoFull: 'acme/app',
    sha: 'abc',
    failOnThreshold: true,
    exitCode: 1,
  });
  assert.ok(md.includes('<summary>src/a\\_b.cs (1 uncovered region(s))</summary>'), md);
  assert.ok(md.includes('| 3 | M\\<T\\> | [src/a\\_b.cs:3](https://github.com/acme/app/blob/abc/src/a_b.cs#L3) |'), md);
});
