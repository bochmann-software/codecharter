'use strict';

// publishViaPortal posts the result to the portal so it can publish a branded
// check run. It must never throw: the caller falls back to the workflow token
// on any non-success. These tests pin the success/failure/exception branches.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { core, HttpClient } from '../src/deps.js';
import { publishViaPortal } from '../src/index.js';

let savedPost;
let savedInfo;
let infos;

beforeEach(() => {
  savedPost = HttpClient.prototype.post;
  savedInfo = core.info;
  infos = [];
  core.info = (m) => infos.push(m);
});

afterEach(() => {
  HttpClient.prototype.post = savedPost;
  core.info = savedInfo;
});

function mockPost(impl) {
  HttpClient.prototype.post = impl;
}

const PAYLOAD = { repository: 'acme/widgets', headSha: 'abc' };

test('publishViaPortal: 2xx → true, posts to the checks endpoint with auth + JSON', async () => {
  let captured;
  mockPost(async (url, body, headers) => {
    captured = { url, body, headers };
    return { message: { statusCode: 201 }, readBody: async () => '' };
  });
  const ok = await publishViaPortal('https://portal', 'KEY', PAYLOAD);
  assert.equal(ok, true);
  assert.equal(captured.url, 'https://portal/api/v1/ci/checks');
  assert.equal(captured.body, JSON.stringify(PAYLOAD));
  assert.equal(captured.headers.Authorization, 'Bearer KEY');
  assert.equal(captured.headers['Content-Type'], 'application/json');
  assert.ok(infos.some((m) => /Published results as the CodeCharter app/.test(m)));
});

test('publishViaPortal: 200 boundary counts as success', async () => {
  mockPost(async () => ({ message: { statusCode: 200 }, readBody: async () => '' }));
  assert.equal(await publishViaPortal('https://portal', 'KEY', PAYLOAD), true);
});

test('publishViaPortal: non-2xx → false with a fallback note (no throw)', async () => {
  mockPost(async () => ({ message: { statusCode: 404 }, readBody: async () => '' }));
  const ok = await publishViaPortal('https://portal', 'KEY', PAYLOAD);
  assert.equal(ok, false);
  assert.ok(infos.some((m) => /HTTP 404.*falling back/.test(m)));
});

test('publishViaPortal: a missing status code is treated as a non-success', async () => {
  mockPost(async () => ({ message: {}, readBody: async () => '' }));
  assert.equal(await publishViaPortal('https://portal', 'KEY', PAYLOAD), false);
});

test('publishViaPortal: a thrown error is swallowed and reported as a fallback', async () => {
  mockPost(async () => {
    throw new Error('connect ECONNREFUSED');
  });
  const ok = await publishViaPortal('https://portal', 'KEY', PAYLOAD);
  assert.equal(ok, false);
  assert.ok(infos.some((m) => /publish failed.*ECONNREFUSED.*falling back/.test(m)));
});
