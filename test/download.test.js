'use strict';

// downloadArchive maps the portal's status codes onto actionable errors and, on
// success, streams the body to disk and surfaces the advertised SHA-256. The
// HttpClient is mocked at the prototype so `new HttpClient(...).get(...)` inside
// the action returns our fake response.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { HttpClient } from '../src/deps.js';
import { downloadArchive } from '../src/index.js';

let destDir;
let savedGet;

beforeEach(() => {
  destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dl-test-'));
  savedGet = HttpClient.prototype.get;
});

afterEach(() => {
  HttpClient.prototype.get = savedGet;
  fs.rmSync(destDir, { recursive: true, force: true });
});

// Installs a fake response for the next get(). `body` becomes a readable stream
// for the success path; status<400 reaches the streaming branch.
function mockResponse({ statusCode, headers = {}, body = '', readBodyText = '' }) {
  HttpClient.prototype.get = async () => ({
    message: Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
      statusCode,
      headers,
    }),
    readBody: async () => readBodyText,
  });
}

test('downloadArchive: 401 → "API key was rejected" guidance', async () => {
  mockResponse({ statusCode: 401 });
  await assert.rejects(downloadArchive('http://portal/cli', 'KEY', destDir, false), /API key was rejected/);
});

test('downloadArchive: 402 → inactive subscription message', async () => {
  mockResponse({ statusCode: 402 });
  await assert.rejects(downloadArchive('http://portal/cli', 'KEY', destDir, false), /subscription is not active/);
});

test('downloadArchive: 404 → no matching release, includes the URL', async () => {
  mockResponse({ statusCode: 404 });
  await assert.rejects(downloadArchive('http://portal/cli/win-x64/v9', 'KEY', destDir, true), /HTTP 404.*win-x64\/v9/s);
});

test('downloadArchive: other 4xx/5xx appends the response body when present', async () => {
  mockResponse({ statusCode: 503, readBodyText: '  upstream down  ' });
  await assert.rejects(downloadArchive('http://portal/cli', 'KEY', destDir, false), /HTTP 503\. upstream down/);
});

test('downloadArchive: success writes the archive and lower-cases the SHA header', async () => {
  const payload = 'binary-archive-bytes';
  mockResponse({
    statusCode: 200,
    headers: { 'x-codeguard-sha256': 'ABCDEF0123' },
    body: payload,
  });
  const { archive, expectedSha } = await downloadArchive('http://portal/cli', 'KEY', destDir, false);
  assert.equal(archive, path.join(destDir, 'codecharter.tar.gz'));
  assert.equal(fs.readFileSync(archive, 'utf8'), payload);
  assert.equal(expectedSha, 'abcdef0123');
});

test('downloadArchive: windows picks the .zip name', async () => {
  mockResponse({ statusCode: 200, headers: {}, body: 'zip' });
  const { archive, expectedSha } = await downloadArchive('http://portal/cli', 'KEY', destDir, true);
  assert.equal(archive, path.join(destDir, 'codecharter.zip'));
  assert.equal(expectedSha, null, 'no header → null digest');
});

test('downloadArchive: a multi-valued SHA header takes the first entry', async () => {
  mockResponse({
    statusCode: 200,
    headers: { 'x-codeguard-sha256': ['DEAD', 'BEEF'] },
    body: 'data',
  });
  const { expectedSha } = await downloadArchive('http://portal/cli', 'KEY', destDir, false);
  assert.equal(expectedSha, 'dead');
});

test('downloadArchive: round-trips with verifySha on a real digest', async () => {
  const payload = 'consistent-bytes';
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  mockResponse({ statusCode: 200, headers: { 'x-codeguard-sha256': sha }, body: payload });
  const { archive, expectedSha } = await downloadArchive('http://portal/cli', 'KEY', destDir, false);
  assert.equal(expectedSha, sha);
  // The on-disk file hashes to the advertised digest.
  const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  assert.equal(actual, sha);
});
