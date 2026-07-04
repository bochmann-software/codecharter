'use strict';

// upsertComment maintains the single sticky PR comment: find one whose body
// starts with the marker and update it, otherwise create a new one. It must
// never fail the build, so a missing token, a non-PR event and API errors are
// all handled gracefully. github.getOctokit is mocked to a fake client.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { core, github } from '../src/deps.js';
import { upsertComment } from '../src/index.js';

const MARKER = '<!-- codeguard-analysis:abc123 -->';
let saved;
let warnings;
let infos;

beforeEach(() => {
  warnings = [];
  infos = [];
  saved = {
    warning: core.warning,
    info: core.info,
    getOctokit: github.getOctokit,
    payload: github.context.payload,
    repo: process.env.GITHUB_REPOSITORY,
  };
  core.warning = (m) => warnings.push(m);
  core.info = (m) => infos.push(m);
  process.env.GITHUB_REPOSITORY = 'acme/widgets';
  github.context.payload = { pull_request: { number: 7 } };
});

afterEach(() => {
  core.warning = saved.warning;
  core.info = saved.info;
  github.getOctokit = saved.getOctokit;
  github.context.payload = saved.payload;
  if (saved.repo === undefined) delete process.env.GITHUB_REPOSITORY;
  else process.env.GITHUB_REPOSITORY = saved.repo;
});

// Builds a fake octokit and records the calls it receives.
function fakeOctokit(existingComments) {
  const calls = { created: [], updated: [] };
  const client = {
    paginate: async () => existingComments,
    rest: {
      issues: {
        listComments: function listComments() {},
        createComment: async (args) => {
          calls.created.push(args);
        },
        updateComment: async (args) => {
          calls.updated.push(args);
        },
      },
    },
  };
  return { client, calls };
}

test('upsertComment: no token → warns and does nothing', async () => {
  let used = false;
  github.getOctokit = () => {
    used = true;
    return {};
  };
  await upsertComment('', MARKER, 'body');
  assert.equal(used, false, 'octokit is never constructed');
  assert.ok(warnings.some((m) => /No github-token/.test(m)));
});

test('upsertComment: not a pull_request event → info, no API calls', async () => {
  github.context.payload = {}; // no pull_request
  let used = false;
  github.getOctokit = () => {
    used = true;
    return {};
  };
  await upsertComment('TOKEN', MARKER, 'body');
  assert.equal(used, false);
  assert.ok(infos.some((m) => /Not a pull_request event/.test(m)));
});

test('upsertComment: no existing comment → creates one with marker + body', async () => {
  const { client, calls } = fakeOctokit([]);
  github.getOctokit = () => client;
  await upsertComment('TOKEN', MARKER, 'the report');
  assert.equal(calls.created.length, 1);
  assert.equal(calls.updated.length, 0);
  assert.equal(calls.created[0].issue_number, 7);
  assert.equal(calls.created[0].body, `${MARKER}\nthe report`);
  assert.ok(infos.some((m) => /Posted the CodeGuard PR comment/.test(m)));
});

test('upsertComment: existing marker comment → updates it, not create', async () => {
  const { client, calls } = fakeOctokit([
    { id: 11, body: 'someone elses comment' },
    { id: 22, body: `${MARKER}\nold report` },
  ]);
  github.getOctokit = () => client;
  await upsertComment('TOKEN', MARKER, 'new report');
  assert.equal(calls.created.length, 0);
  assert.equal(calls.updated.length, 1);
  assert.equal(calls.updated[0].comment_id, 22);
  assert.equal(calls.updated[0].body, `${MARKER}\nnew report`);
  assert.ok(infos.some((m) => /Updated the CodeGuard PR comment \(#22\)/.test(m)));
});

test('upsertComment: a non-string comment body is skipped when scanning', async () => {
  const { client, calls } = fakeOctokit([
    { id: 5, body: null },
    { id: 6, body: `${MARKER}\nhere` },
  ]);
  github.getOctokit = () => client;
  await upsertComment('TOKEN', MARKER, 'x');
  assert.equal(calls.updated.length, 1);
  assert.equal(calls.updated[0].comment_id, 6);
});

test('upsertComment: API error is swallowed as a permissions warning', async () => {
  github.getOctokit = () => ({
    paginate: async () => {
      throw new Error('Resource not accessible by integration');
    },
    rest: { issues: {} },
  });
  await assert.doesNotReject(upsertComment('TOKEN', MARKER, 'body'));
  assert.ok(warnings.some((m) => /pull-requests: write.*Resource not accessible/s.test(m)));
});
