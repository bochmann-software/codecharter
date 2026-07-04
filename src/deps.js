// Central import point for the GitHub Actions toolkit.
//
// The @actions/* packages are ESM-only from their v3+ majors, and an ESM
// namespace object is read-only — you cannot stub a method on it. The unit
// tests work by replacing individual methods (e.g. core.warning, exec.exec), so
// re-export mutable shallow copies the tests can patch. The action code imports
// the toolkit from here rather than from the packages directly, so production
// and tests share the exact same (patchable) singletons.
//
// HttpClient is a class; tests stub its prototype, which works on the original,
// so it is re-exported as-is.

import * as coreNs from '@actions/core';
import * as execNs from '@actions/exec';
import * as ioNs from '@actions/io';
import * as tcNs from '@actions/tool-cache';
import * as cacheNs from '@actions/cache';
import * as githubNs from '@actions/github';
import { HttpClient } from '@actions/http-client';

export const core = { ...coreNs };
export const exec = { ...execNs };
export const io = { ...ioNs };
export const tc = { ...tcNs };
export const cache = { ...cacheNs };
export const github = { ...githubNs };
export { HttpClient };
