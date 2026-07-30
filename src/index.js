import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { core, exec, io, tc, cache, github, HttpClient } from './deps.js';

const MAX_COMMENT_ROWS = 100;

/**
 * Hidden marker that lets the action find and update its own comment instead of
 * posting a new one each run. It embeds a hash of a discriminator so that
 * several CodeCharter steps in the same PR (different workflows/jobs/solutions, or
 * an explicit comment-key) each keep their own comment and never overwrite each
 * other's.
 */
function commentMarker(discriminator) {
  const tag = crypto
    .createHash('sha1')
    .update(discriminator || 'default')
    .digest('hex')
    .slice(0, 12);
  return `<!-- codecharter-analysis:${tag} -->`;
}

// Platforms the portal can serve. process.platform/arch is mapped onto these;
// anything else is an explicit, friendly failure rather than a stray 4xx.
const PLATFORMS = {
  'win32:x64': 'win-x64',
  'linux:x64': 'linux-x64',
  'darwin:x64': 'osx-x64',
  'darwin:arm64': 'osx-arm64',
};

/** Resolves the portal platform token for the current runner. */
function resolvePlatform() {
  const key = `${process.platform}:${process.arch}`;
  const platform = PLATFORMS[key];
  if (!platform) {
    throw new Error(
      `CodeCharter CLI is not available for ${process.platform}/${process.arch}. ` +
        `Supported: ${Object.values(PLATFORMS).join(', ')}.`
    );
  }
  return platform;
}

/**
 * Downloads the CLI archive, returning its path and the SHA-256 the portal
 * advertised (or null). Maps the portal's auth/subscription status codes onto
 * actionable messages. Only the API key authenticates the request.
 */
async function downloadArchive(url, apiKey, destDir, isWindows) {
  const http = new HttpClient('codecharter-action');
  const res = await http.get(url, { Authorization: `Bearer ${apiKey}` });
  const status = res.message.statusCode || 0;

  if (status === 401) {
    await res.readBody();
    throw new Error(
      'API key was rejected. Generate a new one in the portal under API Keys and update the CODECHARTER_API_KEY secret.'
    );
  }
  if (status === 402) {
    await res.readBody();
    throw new Error('CodeCharter subscription is not active. Renew it in the portal.');
  }
  if (status === 404) {
    await res.readBody();
    throw new Error(`No CodeCharter CLI release matched the requested platform and version (HTTP 404): ${url}`);
  }
  if (status >= 400) {
    const body = (await res.readBody()).trim();
    throw new Error(`CLI download failed with HTTP ${status}.${body ? ' ' + body : ''}`);
  }

  const archive = path.join(destDir, isWindows ? 'codecharter.zip' : 'codecharter.tar.gz');
  await pipeline(res.message, fs.createWriteStream(archive));

  const headerSha = res.message.headers['x-codecharter-sha256'] || res.message.headers['x-codeguard-sha256'];
  const expectedSha = Array.isArray(headerSha) ? headerSha[0] : headerSha;
  return { archive, expectedSha: expectedSha ? expectedSha.toLowerCase() : null };
}

/** Throws if the archive's SHA-256 does not match the portal-supplied digest. */
async function verifySha(archive, expectedSha) {
  if (!expectedSha) {
    return;
  }
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(archive), hash);
  const actual = hash.digest('hex');
  if (actual !== expectedSha) {
    throw new Error(`SHA-256 mismatch - downloaded archive is corrupt. expected=${expectedSha} actual=${actual}`);
  }
}

/** Recursively finds the codecharter executable inside an extracted directory. */
function findExecutable(root, isWindows) {
  const names = isWindows
    ? new Set(['codecharter.exe', 'codeguard.exe', 'CodeCharter.Cli.exe', 'CodeGuard.Cli.exe'])
    : new Set(['codecharter', 'codeguard', 'CodeCharter.Cli', 'CodeGuard.Cli']);
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (names.has(entry.name)) {
        return full;
      }
    }
  }
  return null;
}

/**
 * Walks the workspace for project files when no `solution` input is given.
 * Returns workspace-relative paths, ordered shallowest-directory-first then
 * alphabetically, so the choice is deterministic regardless of filesystem
 * order. Solution files (.sln/.slnx) take precedence; .csproj is only
 * collected as a fallback when no solution file exists. Build and VCS
 * directories are skipped.
 */
function discoverSolutions(workspace) {
  const skip = new Set(['node_modules', 'bin', 'obj', '.git']);
  const solutions = [];
  const projects = [];
  const stack = [workspace];
  while (stack.length > 0) {
    const dir = stack.pop();
    // An unreadable directory (permissions, a broken symlinked mount) must not
    // abort the whole walk - skip it so a valid candidate elsewhere is still
    // found. Symlinked directories are reported as non-directories by Dirent,
    // so they are never descended and cannot cause an infinite loop.
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) stack.push(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const rel = path.relative(workspace, full);
      if (ext === '.sln' || ext === '.slnx') solutions.push(rel);
      else if (ext === '.csproj') projects.push(rel);
    }
  }
  const byDepthThenName = (a, b) => {
    const depth = a.split(path.sep).length - b.split(path.sep).length;
    return depth !== 0 ? depth : a.localeCompare(b);
  };
  const chosen = solutions.length > 0 ? solutions : projects;
  return chosen.sort(byDepthThenName);
}

/**
 * Returns true when the repository declares at least one platform profile in
 * `.codecharter/config.yml` (a non-empty `profiles:` block- or flow-list). Those
 * profiles are the CLI's rule source, resolved from the portal — independent of
 * a local `rules/` directory. We probe the file directly (no YAML dependency)
 * only to decide whether the "no rules configured" warning would be a false
 * alarm; a lenient scan is enough because profile slugs contain no `#` or `[`.
 */
function hasConfiguredProfiles(workspace) {
  // Primary .codecharter with a legacy .codeguard fallback, matching the CLI's
  // dual-read so a repository configured before the rename is still detected.
  const configPath = ['.codecharter', '.codeguard']
    .map((dir) => path.join(workspace, dir, 'config.yml'))
    .find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    });
  if (!configPath) return false;

  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    // Unreadable config must not crash the run; treat it as "no profiles" so the
    // existing warning path still applies rather than masking a real gap.
    return false;
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // Strip trailing comments; a top-level `profiles:` key sits at column 0.
    const match = /^profiles:\s*(.*)$/.exec(lines[i].replace(/#.*$/, ''));
    if (!match) continue;

    const inline = match[1].trim();
    // Flow list on the same line: `profiles: [codecharter/csharp-all@latest]`.
    if (inline.startsWith('[')) return /\[\s*[^\s\]]/.test(inline);
    // Any other non-empty scalar after the key counts as configured.
    if (inline.length > 0) return true;

    // Block list: the first indented `- <item>` before the next top-level key.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].replace(/#.*$/, '');
      if (next.trim().length === 0) continue;
      // A new column-0 key that is not a list item ends the profiles block.
      if (/^\S/.test(next) && !next.trimStart().startsWith('-')) break;
      if (/^\s*-\s+\S/.test(next)) return true;
    }
    return false;
  }
  return false;
}

/**
 * Resolves the `diff` input into CLI arguments that scope the analysis to
 * changed lines. The single input is interpreted by value:
 *   - '' / 'false'        -> no diff mode (returns []).
 *   - 'true'              -> on pull requests, diff against the base branch
 *                            (merge-base..head); ignored on other events.
 *   - an existing file    -> used as a unified diff file as-is.
 *   - a value with '..'   -> treated as a git ref range (e.g. main..HEAD).
 * The diff is always computed on the runner (git is available, ownership is
 * correct) and passed to the CLI via `--diff`, so it does not depend on the
 * CLI's working directory. Returns an args array, or null when the input is
 * invalid or the diff could not be computed (a failure is already reported).
 */
async function resolveDiffArgs(diffInput, workspace, tmp) {
  const value = (diffInput || '').trim();
  const lower = value.toLowerCase();
  if (!value || lower === 'false') return [];

  const gitDiffArgs = ['-C', workspace, 'diff', '--unified=0'];

  // Reserved keywords are matched before any file/range interpretation, so a
  // file literally named "true"/"false" cannot hijack the mode.
  if (lower === 'true') {
    const pr = github.context.payload.pull_request;
    if (!pr) {
      core.warning('`diff: true` only scopes analysis on pull_request events; analyzing the whole solution.');
      return [];
    }
    const baseSha = pr.base?.sha;
    const headSha = pr.head?.sha;
    // PR checkouts are often shallow; make the base commit available best-effort.
    await exec.exec('git', ['-C', workspace, 'fetch', '--no-tags', '--depth=1', 'origin', baseSha], {
      ignoreReturnCode: true,
      silent: true,
    });
    // Prefer the merge-base (matches GitHub's "Files changed"); fall back to the
    // base tip when it is not reachable in a shallow clone.
    let base = baseSha;
    let mb = '';
    const mbCode = await exec.exec('git', ['-C', workspace, 'merge-base', baseSha, headSha], {
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (d) => {
          mb += d.toString();
        },
      },
    });
    if (mbCode === 0 && mb.trim()) base = mb.trim();
    gitDiffArgs.push(base, headSha);
  } else {
    // An explicit value: a diff file path wins over a range interpretation, so a
    // path that contains '..' still resolves as a file rather than a git range.
    const asWorkspace = path.resolve(workspace, value);
    if (fs.existsSync(asWorkspace) && fs.statSync(asWorkspace).isFile()) {
      return ['--diff', asWorkspace];
    }
    if (value.includes('..')) {
      gitDiffArgs.push(value);
    } else {
      core.setFailed(
        `Invalid \`diff\` input "${value}". Use 'true'/'false', a git ref range (e.g. main..HEAD), ` +
          'or a path to a unified diff file.'
      );
      return null;
    }
  }

  let out = '';
  // silent: capture the diff without echoing it (it can be large) to the log.
  const code = await exec.exec('git', gitDiffArgs, {
    ignoreReturnCode: true,
    silent: true,
    listeners: {
      stdout: (d) => {
        out += d.toString();
      },
    },
  });
  if (code !== 0) {
    core.setFailed(
      'Could not compute the diff for `diff` mode. Ensure the compared commits are available ' +
        '(check out enough history, e.g. `actions/checkout` with `fetch-depth: 0`).'
    );
    return null;
  }

  const diffFile = path.join(tmp, 'codecharter.diff');
  fs.writeFileSync(diffFile, out);
  if (!out.trim()) {
    core.warning('The resolved diff is empty; in diff mode that means nothing is analyzed.');
  }
  return ['--diff', diffFile];
}

/** Reads and parses a JSON file, or returns null if missing/invalid. */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Counts violations by normalized severity. */
function tally(report) {
  const violations = report.violations || [];
  const counts = { total: violations.length, error: 0, warn: 0, info: 0 };
  for (const v of violations) {
    const s = (v.severity || '').toLowerCase();
    if (s === 'error') counts.error++;
    else if (s === 'warning' || s === 'warn') counts.warn++;
    else counts.info++;
  }
  return counts;
}

/** CLI severities (error|warning|info) → the action's short labels. */
function severityLabel(severity) {
  const s = (severity || '').toLowerCase();
  if (s === 'error') return 'error';
  if (s === 'warning' || s === 'warn') return 'warn';
  return 'info';
}

/** Workspace-relative, forward-slashed path (no leading slash). */
function displayPath(filePath, workspace) {
  if (!filePath) return '';
  let p = filePath;
  if (path.isAbsolute(p)) {
    const rel = path.relative(workspace, p);
    if (rel && !rel.startsWith('..')) p = rel;
  }
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** shields.io colour for the min-severity badge. */
function minSeverityColor(threshold) {
  const t = (threshold || '').toLowerCase();
  if (t === 'error') return 'red';
  if (t === 'warn' || t === 'warning') return 'yellow';
  if (t === 'info') return 'blue';
  return 'lightgrey';
}

/** Coloured severity badge for a table cell. */
function severityBadge(severity) {
  switch (severityLabel(severity)) {
    case 'error':
      return '![error](https://img.shields.io/badge/ERROR-d9534f?style=flat-square)';
    case 'warn':
      return '![warn](https://img.shields.io/badge/WARN-f0ad4e?style=flat-square)';
    default:
      return '![info](https://img.shields.io/badge/INFO-5bc0de?style=flat-square)';
  }
}

/** Linkified `file:line` pointing at the blob for the analyzed commit. */
function locationLink(violation, workspace, repoFull, sha) {
  const rel = displayPath(violation.filePath, workspace);
  if (!rel) return '-';
  const name = rel.split('/').pop();
  if (violation.lineNumber) {
    return `[${name}:${violation.lineNumber}](https://github.com/${repoFull}/blob/${sha}/${rel}#L${violation.lineNumber})`;
  }
  return `[${name}](https://github.com/${repoFull}/blob/${sha}/${rel})`;
}

/** Severity sort rank (errors first). */
function severityRank(severity) {
  const l = severityLabel(severity);
  return l === 'error' ? 0 : l === 'warn' ? 1 : 2;
}

/** shields.io colour for the fail-on badge. */
function failOnColor(failOn) {
  const f = (failOn || '').toLowerCase();
  if (f === 'error') return 'red';
  if (f === 'warn' || f === 'warning') return 'yellow';
  if (f === 'info') return 'blue';
  return 'lightgrey'; // never
}

/** shields.io fail-on badge. */
function failOnBadge(failOn) {
  const value = (failOn || 'never').toLowerCase();
  return `![fail-on](https://img.shields.io/badge/fail--on-${encodeURIComponent(value)}-${failOnColor(value)}?style=flat-square)`;
}

/**
 * Footer line that reflects the actual fail-on policy: how many findings are at
 * or above the threshold that fails the check, or that nothing blocks at all.
 */
function footerLine(failOn, counts) {
  const f = (failOn || 'never').toLowerCase();
  if (f === 'never') {
    return '_Reporting only — this run does not fail the check (`fail-on: never`)._';
  }
  let blocking;
  if (f === 'error') blocking = counts.error;
  else if (f === 'warn' || f === 'warning') blocking = counts.error + counts.warn;
  else blocking = counts.total; // info
  const label = f === 'warning' ? 'warn' : f;
  return blocking > 0
    ? `_Fix **${blocking}** finding(s) at or above \`${label}\` before merging._`
    : `_No findings at or above \`${label}\`._`;
}

/**
 * Builds the Markdown report: a badge summary, collapsible per-category
 * sections with linked locations, and a footer. Mirrors the report the
 * previous internal action posted.
 */
function buildComment(report, counts, workspace, opts) {
  const { severityThreshold, repoFull, sha, titleSuffix, failOn } = opts;
  const minBadge = `![min-severity](https://img.shields.io/badge/min--severity-${encodeURIComponent(severityThreshold)}-${minSeverityColor(severityThreshold)}?style=flat-square)`;
  const gateBadge = failOnBadge(failOn);
  const heading = titleSuffix ? `## CodeCharter Analysis — \`${titleSuffix}\`` : '## CodeCharter Analysis';
  const lines = [heading, ''];

  if (counts.total === 0) {
    lines.push(
      `![issues](https://img.shields.io/badge/issues-0-brightgreen?style=flat-square) ${minBadge} ${gateBadge}`
    );
    return lines.join('\n');
  }

  let badges = `${minBadge} ${gateBadge}`;
  if (counts.error > 0)
    badges += ` ![errors](https://img.shields.io/badge/errors-${counts.error}-red?style=flat-square)`;
  if (counts.warn > 0)
    badges += ` ![warnings](https://img.shields.io/badge/warnings-${counts.warn}-yellow?style=flat-square)`;
  if (counts.info > 0) badges += ` ![info](https://img.shields.io/badge/info-${counts.info}-blue?style=flat-square)`;
  lines.push(badges, '');

  const violations = report.violations || [];
  const categories = [...new Set(violations.map((v) => v.category || 'Uncategorized'))].sort((a, b) =>
    a.localeCompare(b)
  );

  let rendered = 0;
  let truncated = false;
  for (const category of categories) {
    if (truncated) break;
    const inCategory = violations.filter((v) => (v.category || 'Uncategorized') === category);
    const ce = inCategory.filter((v) => severityLabel(v.severity) === 'error').length;
    const cw = inCategory.filter((v) => severityLabel(v.severity) === 'warn').length;
    const ci = inCategory.filter((v) => severityLabel(v.severity) === 'info').length;
    const parts = [];
    if (ce) parts.push(`${ce} errors`);
    if (cw) parts.push(`${cw} warnings`);
    if (ci) parts.push(`${ci} info`);

    lines.push(
      '<details>',
      `<summary>${category} (${parts.join(', ')})</summary>`,
      '',
      '| Severity | Rule | Location |',
      '|----------|------|----------|'
    );
    for (const v of [...inCategory].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))) {
      if (rendered >= MAX_COMMENT_ROWS) {
        truncated = true;
        break;
      }
      // Escape backslashes first, then pipes, so a rule name containing a
      // backslash cannot break the Markdown table cell (or double-escape).
      const rule = (v.ruleName || '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
      lines.push(`| ${severityBadge(v.severity)} | ${rule} | ${locationLink(v, workspace, repoFull, sha)} |`);
      rendered++;
    }
    lines.push('', '</details>', '');
  }

  if (truncated) {
    lines.push(
      `_Showing the first ${MAX_COMMENT_ROWS} findings; see the inline annotations on the Files changed tab for the rest._`,
      ''
    );
  }

  lines.push('---');
  lines.push(footerLine(failOn, counts));
  return lines.join('\n');
}

/**
 * Flattens a `codecharter coverage` JSON report into the numbers the comment,
 * the outputs and the gate all need. Missing or malformed fields degrade to
 * "nothing measured" rather than to a passing gate.
 */
function coverageSummary(report) {
  const s = (report && report.summary) || {};
  const percent = typeof s.percent === 'number' ? s.percent : null;
  const required = typeof s.minimumRequiredPercent === 'number' ? s.minimumRequiredPercent : null;
  return {
    total: Number(s.totalLines) || 0,
    covered: Number(s.coveredLines) || 0,
    percent,
    required,
    source: s.minimumRequiredPercentSource || 'default',
    met: s.hasMetThreshold === true,
    regions: (report && report.uncoveredRegions) || [],
    projects: (report && report.testResults) || [],
    // Summed once here so the comment and the badge payload read the same
    // numbers without walking the projects twice.
    testCounts: testCountsFor(report && report.testResults),
  };
}

/**
 * Sums the per-project test counts a coverage report carries (CLI >= v1.4.5).
 * Projects that report no counts at all — every report written by an older CLI,
 * and a project whose test run produced no parsable counts — are skipped, so
 * mixed reports still sum the projects that do have numbers. Returns null only
 * when no project reported anything, which the callers render as "unknown"
 * rather than as zero tests.
 */
function testCountsFor(projects) {
  const fields = ['total', 'passed', 'failed', 'skipped'];
  const totals = { total: 0, passed: 0, failed: 0, skipped: 0 };
  let any = false;
  for (const project of projects || []) {
    if (!project || typeof project !== 'object') continue;
    const numbers = fields.filter((f) => Number.isFinite(project[f]));
    if (numbers.length === 0) continue;
    any = true;
    for (const field of numbers) totals[field] += project[field];
  }
  return any ? totals : null;
}

/**
 * Renders the aggregate test counts as a compact table for the sticky comment.
 * Returns an empty array when the report carries no counts, so a report from an
 * older CLI simply omits the table instead of showing zeros.
 */
function testCountRows(counts) {
  if (!counts) return [];
  return [
    '| Tests | Passed | Failed | Skipped |',
    '|-------|--------|--------|---------|',
    `| ${counts.total} | ${counts.passed} | ${counts.failed} | ${counts.skipped} |`,
    '',
  ];
}

/**
 * Rounds a percentage down to two decimals, matching the number the badge shows.
 * Flooring (not rounding) is deliberate: 99.999% must never be advertised as
 * 100%. The intermediate `toFixed` absorbs binary-float error so a clean value
 * like 98.33 does not floor to 98.32.
 */
function floorPercent(percent) {
  return Math.floor(Number((percent * 100).toFixed(6))) / 100;
}

/**
 * Builds the opt-in `badge` object attached to the portal check payload. It
 * carries only aggregate numbers plus the branch they belong to, so the portal
 * can serve repository badges without storing anything else. Fields the calling
 * mode does not know stay null.
 */
function buildBadgePayload({ coverage = null, findings = null, testCounts = null } = {}) {
  const branch = process.env.GITHUB_REF_NAME || '';
  const defaultBranch = github.context.payload?.repository?.default_branch || '';
  return {
    branch,
    isDefaultBranch: branch !== '' && defaultBranch !== '' && branch === defaultBranch,
    coverage,
    findings,
    testCounts,
  };
}

/**
 * Attaches the opt-in badge object to a check payload. Without the opt-in the
 * property is absent entirely (not null), so a run that did not ask for badges
 * sends the portal no numbers to store.
 */
function withBadge(payload, wantBadge, badge) {
  return wantBadge ? { ...payload, badge: badge() } : payload;
}

/** The badge payload for a coverage run; coverage stays null without data. */
function coverageBadgePayload(summary) {
  return buildBadgePayload({
    coverage:
      summary.percent === null
        ? null
        : {
            percent: floorPercent(summary.percent),
            requiredPercent: summary.required,
            met: summary.met,
            coveredLines: summary.covered,
            measurableLines: summary.total,
          },
    testCounts: summary.testCounts,
  });
}

/** The badge payload for an analysis run: finding counts by severity. */
function analysisBadgePayload(counts) {
  return buildBadgePayload({
    findings: { errors: counts.error, warnings: counts.warn, infos: counts.info },
  });
}

/**
 * Builds the Markdown report for a coverage run: a badge line, the uncovered
 * regions grouped by file with linked locations, and a footer stating the gate
 * verdict. Mirrors the shape of the analysis comment so both read alike.
 */
function buildCoverageComment(summary, workspace, opts) {
  const { repoFull, sha, titleSuffix, failOnThreshold, exitCode } = opts;
  const heading = titleSuffix ? `## CodeCharter Coverage — \`${titleSuffix}\`` : '## CodeCharter Coverage';
  const lines = [heading, ''];

  if (exitCode === 3 || summary.percent === null) {
    lines.push('![coverage](https://img.shields.io/badge/coverage-no%20data-lightgrey?style=flat-square)', '');
    lines.push('---', '_No coverage data was produced, so the gate could not be evaluated._');
    return lines.join('\n');
  }

  const shown = summary.percent.toFixed(2);
  const color = summary.met ? 'brightgreen' : 'red';
  let badges = `![coverage](https://img.shields.io/badge/coverage-${encodeURIComponent(`${shown}%`)}-${color}?style=flat-square)`;
  if (summary.required !== null) {
    badges += ` ![required](https://img.shields.io/badge/required-${encodeURIComponent(`${summary.required}%`)}-blue?style=flat-square)`;
  }
  lines.push(badges, '');
  lines.push(
    `${summary.covered} of ${summary.total} measurable lines covered (threshold from \`${summary.source}\`).`,
    ''
  );
  lines.push(...testCountRows(summary.testCounts));

  const byFile = new Map();
  for (const region of summary.regions) {
    const key = displayPath(region.relativeFile || region.file, workspace);
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(region);
  }

  let rendered = 0;
  let truncated = false;
  for (const [file, regions] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (truncated) break;
    lines.push(
      '<details>',
      `<summary>${file} (${regions.length} uncovered region(s))</summary>`,
      '',
      '| Lines | Method | Location |',
      '|-------|--------|----------|'
    );
    for (const region of regions) {
      if (rendered >= MAX_COMMENT_ROWS) {
        truncated = true;
        break;
      }
      const numbers = region.lines || [];
      const first = numbers[0];
      const last = numbers[numbers.length - 1];
      const span = numbers.length > 1 ? `${first}-${last}` : `${first ?? '?'}`;
      const method = (region.method || '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
      const link =
        repoFull && sha && first
          ? `[${file}:${first}](https://github.com/${repoFull}/blob/${sha}/${file}#L${first})`
          : `${file}:${first ?? '?'}`;
      lines.push(`| ${span} | ${method} | ${link} |`);
      rendered++;
    }
    lines.push('', '</details>', '');
  }

  if (truncated) {
    lines.push(`_Showing the first ${MAX_COMMENT_ROWS} uncovered regions; the full report is in the job summary._`, '');
  }

  lines.push('---');
  lines.push(coverageFooterLine(summary, failOnThreshold));
  return lines.join('\n');
}

/** Footer stating whether the run blocks the merge and what to do about it. */
function coverageFooterLine(summary, failOnThreshold) {
  if (summary.met) return '_Coverage meets the required minimum._';
  if (!failOnThreshold) {
    return '_Coverage is below the required minimum; not failing the check (`fail-on-threshold: false`)._';
  }
  return '_Cover the regions above before merging, or lower `coverage.minimum-percent` in `.codecharter/config.yml`._';
}

/** Maps a coverage exit code to a check-run conclusion. */
function coverageConclusion(exitCode, failOnThreshold) {
  if (exitCode === 0) return 'success';
  if (exitCode === 1) return failOnThreshold ? 'failure' : 'neutral';
  return 'failure';
}

/** One-line check-run title for a coverage run. */
function coverageTitle(exitCode, summary) {
  if (exitCode === 2) return 'Tests failed or coverage was incomplete';
  if (exitCode === 3) return 'No coverage data';
  if (exitCode === 64) return 'Coverage could not run (usage, config, or environment error)';
  if (summary.percent === null) return 'No coverage data';
  const shown = `${summary.percent.toFixed(2)}%`;
  return summary.met ? `Coverage ${shown}` : `Coverage ${shown} is below the required minimum`;
}

/** Writes the report to the job summary (best effort). */
async function writeSummary(markdown) {
  try {
    await core.summary.addRaw(markdown).write();
  } catch (err) {
    core.debug(`Could not write job summary: ${err}`);
  }
}

/** Upserts the sticky PR comment keyed by its marker. Never fails the build. */
async function upsertComment(token, marker, markdown) {
  if (!token) {
    core.warning('No github-token available; skipping the PR comment.');
    return;
  }
  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.info('Not a pull_request event; skipping the PR comment (annotations and job summary still apply).');
    return;
  }

  const body = `${marker}\n${markdown}`;
  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const existing = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pr.number,
      per_page: 100,
    });
    const mine = existing.find((c) => typeof c.body === 'string' && c.body.startsWith(marker));
    if (mine) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
      core.info(`Updated the CodeCharter PR comment (#${mine.id}).`);
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: pr.number, body });
      core.info('Posted the CodeCharter PR comment.');
    }
  } catch (err) {
    core.warning(
      `Could not post the PR comment (the workflow needs 'permissions: pull-requests: write'): ${
        err instanceof Error ? err.message : err
      }`
    );
  }
}

/** GitHub check conclusion derived from the fail-on policy and counts. */
function conclusionFor(failOn, counts) {
  const f = (failOn || '').toLowerCase();
  if (f === 'never') return 'neutral';
  const blocking =
    f === 'error' ? counts.error : f === 'warn' || f === 'warning' ? counts.error + counts.warn : counts.total;
  return blocking > 0 ? 'failure' : 'success';
}

/** Short check-run title summarizing the counts. */
function titleFor(counts) {
  return counts.total === 0 ? 'No findings' : `${counts.error} error, ${counts.warn} warning, ${counts.info} info`;
}

/**
 * Publishes the result as the CodeCharter App via the portal. Returns true on
 * success; false (with an info log) when the App is not installed/linked or the
 * portal is unavailable, so the caller can fall back to the workflow token.
 * Never throws.
 */
async function publishViaPortal(portal, apiKey, payload) {
  try {
    const http = new HttpClient('codecharter-action');
    const res = await http.post(`${portal}/api/v1/ci/checks`, JSON.stringify(payload), {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    });
    await res.readBody();
    const status = res.message.statusCode || 0;
    if (status >= 200 && status < 300) {
      core.info('Published results as the CodeCharter app (branded check run + comment).');
      return true;
    }
    core.info(`CodeCharter app not used (portal returned HTTP ${status}); falling back to the workflow token.`);
    return false;
  } catch (err) {
    core.info(
      `CodeCharter app publish failed (${err instanceof Error ? err.message : err}); falling back to the workflow token.`
    );
    return false;
  }
}

/**
 * Resolves a version selector (latest, v1, v1.4) to a concrete version via the
 * portal's lightweight manifest endpoint, without downloading the archive.
 * Returns the parsed manifest ({ version, sha256, ... }) or null when the
 * endpoint is unavailable (older portal that 404s the route, non-2xx, invalid
 * body, or a network error), so the caller can fall back to its old behavior.
 */
async function fetchManifest(portal, platform, version, apiKey) {
  try {
    const http = new HttpClient('codecharter-action');
    const res = await http.get(`${portal}/api/v1/cli/${platform}/${version}/manifest`, {
      Authorization: `Bearer ${apiKey}`,
    });
    const status = res.message.statusCode || 0;
    const body = await res.readBody();
    if (status < 200 || status >= 300) return null;
    const manifest = JSON.parse(body);
    return manifest && typeof manifest.version === 'string' ? manifest : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the codecharter executable, using the Actions cache to avoid
 * re-downloading the (~50 MB) CLI archive between runs. The cached directory
 * holds only the generic binary — the minted license lives elsewhere and is
 * never cached. Caching is best-effort: any cache error falls back to a fresh
 * download, so it never breaks a run.
 */
async function obtainCli({ portal, platform, version, apiKey, isWindows, tmp, cacheEnabled }) {
  const cacheBase = process.env.RUNNER_TOOL_CACHE || path.join(os.homedir() || tmp, '.codecharter');

  // Exact pins (1.2.3 / v1.2.3) are immutable. For a moving selector (latest,
  // v1, v1.4) resolve the concrete version up front so the cache is keyed by the
  // actual version: an unchanged version hits the cache (no re-download), and a
  // new release misses and re-downloads immediately. Requesting that resolved
  // version from the portal (rather than the selector) also closes the race
  // where a release lands between the manifest lookup and the download. If the
  // manifest endpoint is unavailable (older portal, network), fall back to a
  // per-day key so a hit never serves a stale build for long.
  const isExact = /^v?\d+\.\d+\.\d+$/.test(version);
  let keyVersion = version; // discriminates the cache entry
  let downloadVersion = version; // version requested from the portal
  let manifestSha = null; // archive SHA-256 from the manifest, if resolved
  if (!isExact && cacheEnabled) {
    const manifest = await fetchManifest(portal, platform, version, apiKey);
    if (manifest) {
      keyVersion = manifest.version;
      downloadVersion = manifest.version;
      manifestSha = (manifest.sha256 || '').toLowerCase() || null;
      core.debug(`Resolved CLI selector "${version}" to ${keyVersion} via the manifest endpoint.`);
    } else {
      const day = new Date().toISOString().slice(0, 10);
      keyVersion = `${version}-${day}`;
      core.debug(
        `CLI manifest lookup unavailable for "${version}" (older portal or network); ` +
          'falling back to a per-day cache key.'
      );
    }
  }

  const cliDir = path.join(cacheBase, 'codecharter-cli', platform, keyVersion);
  const cacheKey = `codecharter-cli-${platform}-${keyVersion}`;

  // Only use the cache when the Actions cache service is actually reachable;
  // on runners without it, isFeatureAvailable() is false and we skip quietly
  // instead of emitting the library's restore/save warnings every run.
  let canCache = cacheEnabled && cache.isFeatureAvailable();
  if (cacheEnabled && !canCache) {
    core.debug('Actions cache service is not available; downloading without cache.');
  }

  // The Actions cache stores entries as a tar compressed with zstd or gzip.
  // Self-hosted runners that have neither on PATH make saveCache fail late with
  // an opaque "Failed to save" / broken-pipe error. Detect it up front and skip
  // caching with an actionable note instead of letting the save blow up.
  if (canCache) {
    const hasCompressor = (await io.which('zstd', false)) || (await io.which('gzip', false));
    if (!hasCompressor) {
      canCache = false;
      core.warning(
        'Skipping the CodeCharter CLI cache: neither `zstd` nor `gzip` was found on the runner PATH, ' +
          'and the Actions cache needs one of them to compress entries. The CLI is downloaded fresh for ' +
          'this run, which does not affect the analysis. What to do: install zstd or gzip on the runner ' +
          'to enable caching, or set `cache: false` on this action to skip caching and silence this warning.'
      );
    }
  }

  // Start clean so a stale local copy (persistent self-hosted runner) cannot
  // shadow a cache miss.
  await io.rmRF(cliDir);
  await io.mkdirP(cliDir);

  if (canCache) {
    try {
      if (await cache.restoreCache([cliDir], cacheKey)) {
        const cached = findExecutable(cliDir, isWindows);
        if (cached) {
          if (!isWindows) fs.chmodSync(cached, 0o755);
          core.info(`Using cached CodeCharter CLI (${platform}, ${keyVersion}).`);
          return cached;
        }
      }
    } catch (err) {
      core.debug(`Cache restore skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  core.info(`Downloading CodeCharter CLI (${platform}, ${downloadVersion}) from ${portal}`);
  const url = `${portal}/api/v1/cli/${platform}/${downloadVersion}`;
  const { archive, expectedSha } = await downloadArchive(url, apiKey, tmp, isWindows);
  // Prefer the manifest's SHA-256 when we resolved one: it pins the cached
  // artifact to the exact version the cache key names. Otherwise trust the
  // download's own X-CodeCharter-Sha256 header.
  await verifySha(archive, manifestSha || expectedSha);
  if (isWindows) {
    await tc.extractZip(archive, cliDir);
  } else {
    await tc.extractTar(archive, cliDir);
  }

  const exe = findExecutable(cliDir, isWindows);
  if (!exe) {
    throw new Error('Extracted archive does not contain a codecharter executable.');
  }
  if (!isWindows) fs.chmodSync(exe, 0o755);

  if (canCache) {
    try {
      await cache.saveCache([cliDir], cacheKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/reserve|already exists|already been/i.test(msg)) {
        // A concurrent run stored the same key first; benign, no action needed.
        core.debug(`Cache save skipped (another run cached it first): ${msg}`);
      } else {
        // Non-fatal: the CLI is already downloaded for this run. But the
        // actions/cache library prints an opaque "Failed to save" warning, so
        // spell out the likely cause and the fix.
        core.warning(
          `Could not save the CodeCharter CLI to the Actions cache: ${msg}. ` +
            'This does not affect the analysis - the CLI was downloaded for this run. ' +
            'On self-hosted runners this is usually a missing `gzip` on PATH (the cache uses tar+gzip). ' +
            'What to do: install gzip on the runner, or set `cache: false` on this action to skip caching and silence this warning.'
        );
      }
    }
  }
  return exe;
}

/**
 * Coverage mode: runs `codecharter coverage`, reports the uncovered regions and
 * gates on the threshold. The CLI runs the tests itself, so this path only
 * shapes arguments, renders the report and maps the exit code to a verdict.
 */
async function runCoverage(ctx) {
  const { exe, env, workspace, tmp, portal, apiKey, options } = ctx;

  const jsonPath = options.reportOutput
    ? path.resolve(workspace, options.reportOutput)
    : path.join(tmp, 'coverage.json');
  const args = ['coverage', path.resolve(workspace, options.root || '.'), '--output-file', jsonPath];
  if (options.minCoverage) args.push('--min-coverage', options.minCoverage);
  if (options.skipTests) args.push('--skip-tests');
  if (options.resultsRoot) args.push('--results-root', path.resolve(workspace, options.resultsRoot));

  const hasDotnet = (await io.which('dotnet', false)) || process.env.DOTNET_ROOT;
  if (!hasDotnet) {
    core.warning(
      'No .NET SDK detected on the runner. The coverage gate runs `dotnet test`, which needs one. ' +
        'What to do: add `- uses: actions/setup-dotnet@v4` (with your target `dotnet-version`) before this action.'
    );
  }

  const code = await exec.exec(exe, args, { env, ignoreReturnCode: true });

  const report = readJson(jsonPath);
  const summary = coverageSummary(report);
  core.setOutput('coverage-percent', summary.percent === null ? '' : summary.percent);
  core.setOutput('coverage-met', String(summary.met));
  core.setOutput('coverage-uncovered-regions', summary.regions.length);
  if (options.reportOutput) core.setOutput('coverage-report-path', jsonPath);

  const repoFull = process.env.GITHUB_REPOSITORY || `${github.context.repo.owner}/${github.context.repo.repo}`;
  const sha = github.context.payload.pull_request?.head?.sha || github.context.sha;
  const titleSuffix = options.commentKey || options.root || '';
  const discriminator =
    options.commentKey || [process.env.GITHUB_WORKFLOW, process.env.GITHUB_JOB, 'coverage'].filter(Boolean).join(' / ');
  const markdown = buildCoverageComment(summary, workspace, {
    repoFull,
    sha,
    titleSuffix,
    failOnThreshold: options.failOnThreshold,
    exitCode: code,
  });
  await writeSummary(markdown);

  const published = await publishViaPortal(
    portal,
    apiKey,
    withBadge(
      {
        repository: repoFull,
        headSha: sha,
        pullNumber: github.context.payload.pull_request?.number ?? null,
        checkName: titleSuffix ? `CodeCharter Coverage / ${titleSuffix}` : 'CodeCharter Coverage',
        conclusion: coverageConclusion(code, options.failOnThreshold),
        title: coverageTitle(code, summary),
        summary: markdown,
        annotations: [],
        comment: options.wantComment,
        commentKey: discriminator,
      },
      options.badge,
      () => coverageBadgePayload(summary)
    )
  );
  if (!published && options.wantComment) {
    await upsertComment(options.githubToken, commentMarker(discriminator), markdown);
  }

  if (code === 0) return;
  if (code === 1) {
    const detail =
      `Coverage is ${summary.percent === null ? 'unknown' : `${summary.percent.toFixed(2)}%`}, below the required ` +
      `${summary.required ?? 100}% (threshold from \`${summary.source}\`).`;
    if (options.failOnThreshold) {
      core.setFailed(
        `${detail} What to do: cover the regions listed above, or lower \`coverage.minimum-percent\` in ` +
          '`.codecharter/config.yml` (or pass a different `min-coverage`).'
      );
    } else {
      core.info(`${detail} Not failing the build (fail-on-threshold: false).`);
    }
    return;
  }
  if (code === 2) {
    core.setFailed(
      'The coverage run failed because tests failed or the coverage data was incomplete. ' +
        'What to do: fix the failing tests shown above; the gate only evaluates a complete run.'
    );
    return;
  }
  if (code === 3) {
    core.setFailed(
      'The coverage run produced no coverage data. What to do: make sure every test project references ' +
        '`coverlet.collector`, and that the `coverage-root` input points at the tree that contains them.'
    );
    return;
  }
  core.setFailed(
    `The coverage run could not start (exit code ${code === null ? 'null (process terminated)' : code}). ` +
      'Common causes are a missing .NET SDK, an unwritable report path, or an invalid `.codecharter` config. ' +
      'Check the messages above.'
  );
}

async function run() {
  const apiKey = core.getInput('api-key', { required: true });
  core.setSecret(apiKey);

  const mode = (core.getInput('mode') || 'analyze').toLowerCase();
  if (mode !== 'analyze' && mode !== 'coverage') {
    core.setFailed(`Unknown \`mode\`: "${mode}". Valid values are \`analyze\` (default) and \`coverage\`.`);
    return;
  }

  let solution = core.getInput('solution');
  const rules = core.getInput('rules');
  const requireRules = (core.getInput('require-rules') || 'false').toLowerCase() === 'true';
  const failOn = core.getInput('fail-on') || 'error';
  const severity = core.getInput('severity-threshold') || 'info';
  const version = core.getInput('version') || 'latest';
  const portal = (core.getInput('portal-base-url') || 'https://codecharter.tools').replace(/\/+$/, '');
  const githubToken = core.getInput('github-token');
  const wantComment = (core.getInput('comment') || 'true').toLowerCase() !== 'false';
  const commentKey = core.getInput('comment-key');
  const sarifOutput = core.getInput('sarif-output');
  const wantCache = (core.getInput('cache') || 'true').toLowerCase() !== 'false';
  const diffInput = core.getInput('diff');
  const baselineInput = core.getInput('baseline');
  const wantTelemetry = (core.getInput('telemetry') || 'false').toLowerCase() === 'true';
  const wantBadge = (core.getInput('badge') || 'false').toLowerCase() === 'true';

  const isWindows = process.platform === 'win32';
  const platform = resolvePlatform();
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

  // With no explicit input, auto-discover a project to analyze: prefer a
  // solution file (.sln/.slnx), fall back to a .csproj, and pick the
  // shallowest/alphabetically-first candidate so the choice is stable.
  if (mode !== 'coverage' && !solution.trim()) {
    const candidates = discoverSolutions(workspace);
    if (candidates.length === 0) {
      core.setFailed(
        'No `solution` input was given and no .sln, .slnx, or .csproj file was found in the repository. ' +
          'What to do: set the `solution` input to a path relative to the repository root, or make sure ' +
          'the code is checked out before this step (e.g. `- uses: actions/checkout@v4`).'
      );
      return;
    }
    solution = candidates[0];
    if (candidates.length > 1) {
      // Cap the listing so a monorepo with hundreds of projects does not flood
      // the log; the chosen file is always shown first.
      const shown = candidates.slice(0, 10);
      const more = candidates.length - shown.length;
      const list = shown.join(', ') + (more > 0 ? `, and ${more} more` : '');
      core.warning(
        `Found ${candidates.length} project files; analyzing "${solution}". ` +
          `Set the \`solution\` input to choose explicitly. Candidates: ${list}.`
      );
    }
    core.info(`Auto-discovered solution: ${solution}`);
  }

  // Everything lives under one temp dir so the binary and the short-lived
  // license are removed together in finally, on every exit path.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codecharter-'));
  try {
    const exe = await obtainCli({
      portal,
      platform,
      version,
      apiKey,
      isWindows,
      tmp,
      cacheEnabled: wantCache && version !== 'local',
    });

    // The CLI (>= v1.0.3) mints its own short-lived (24h) license before the
    // license gate when CODECHARTER_API_KEY is set, fetching it with the API key
    // as the only credential. XDG_CONFIG_HOME (the renewer's highest-precedence
    // cache location, cross-OS) points at the ephemeral temp dir, so the minted
    // license is isolated and removed with it - no long-lived license ever
    // lands on the runner. Revoking the API key disables CI within <= 24h.
    const configDir = path.join(tmp, 'config');
    await io.mkdirP(configDir);
    const env = {
      ...process.env,
      CODECHARTER_API_KEY: apiKey,
      CODECHARTER_PORTAL_URL: portal,
      CODEGUARD_API_KEY: apiKey,
      CODEGUARD_PORTAL_URL: portal,
      XDG_CONFIG_HOME: configDir,
    };

    if (mode === 'coverage') {
      await runCoverage({
        exe,
        env,
        workspace,
        tmp,
        portal,
        apiKey,
        options: {
          root: core.getInput('coverage-root'),
          minCoverage: core.getInput('min-coverage'),
          skipTests: (core.getInput('skip-tests') || 'false').toLowerCase() === 'true',
          resultsRoot: core.getInput('results-root'),
          failOnThreshold: (core.getInput('fail-on-threshold') || 'true').toLowerCase() !== 'false',
          reportOutput: core.getInput('coverage-report'),
          badge: wantBadge,
          wantComment,
          commentKey,
          githubToken,
        },
      });
      return;
    }

    // One analyze run, several outputs (CLI >= v1.0.6): github-annotations to
    // stdout for inline PR annotations, json to a temp file for the comment and
    // findings outputs, and optionally sarif to the workspace for Code Scanning.
    const jsonPath = path.join(tmp, 'results.json');
    const sarifPath = sarifOutput && sarifOutput.trim() ? path.resolve(workspace, sarifOutput.trim()) : null;

    const args = [
      'analyze',
      // resolve (not join) so an absolute `solution` is used as-is instead of
      // being appended to the workspace, which would produce a doubled path
      // like `<workspace>\C:\...\App.sln`. Relative inputs resolve against the
      // workspace exactly as before.
      path.resolve(workspace, solution),
      '--workspace-root',
      workspace,
      '--severity',
      severity,
      '--output',
      'github-annotations',
      '--output',
      `json:${jsonPath}`,
    ];
    if (sarifPath) {
      args.push('--output', `sarif:${sarifPath}`);
    }
    if (rules && rules.trim()) {
      // Same absolute-vs-relative handling as the solution path above.
      args.push('--rules', path.resolve(workspace, rules.trim()));
    } else {
      // No explicit `rules`: the CLI resolves rules itself. It runs a `.codecharter/
      // config.yml` platform profile (resolved from the portal) when one is
      // declared, and/or a local `rules/` directory in the repo root; only with
      // none of those does it fall back to the sample rules bundled with the CLI.
      // That fallback is silent at default verbosity, which surprises users who
      // expect their own rule set. Mirror the CLI's probes — config profiles and
      // the repo-root `rules/` dir — so the warning fires only when there is
      // genuinely no rule source, and `require-rules` refuses only that case.
      const localRules = path.join(workspace, 'rules');
      const hasLocalRules = fs.existsSync(localRules) && fs.statSync(localRules).isDirectory();
      const hasProfiles = hasConfiguredProfiles(workspace);
      if (!hasLocalRules && !hasProfiles) {
        const detail =
          'No `rules` input was set, no `rules/` directory exists in the repository root, and no ' +
          '`.codecharter/config.yml` declares any `profiles:`, so CodeCharter would analyze against ' +
          "the CLI's bundled sample rules. What to do: add a platform profile to " +
          '`.codecharter/config.yml` under `profiles:`, add a `rules/` directory with your `.cgr` ' +
          'rules, or point the `rules` input at your rules directory.';
        if (requireRules) {
          core.setFailed(detail + ' This step has `require-rules: true`, which forbids the bundled-rules fallback.');
          return;
        }
        core.warning(detail);
      }
    }
    if (failOn !== 'never') {
      args.push('--fail-on', failOn);
    }

    // Diff mode: scope findings (and the fail-on gate) to changed lines only.
    // A null result means the input was invalid or the diff failed; the helper
    // already called setFailed, so stop here.
    const diffArgs = await resolveDiffArgs(diffInput, workspace, tmp);
    if (diffArgs === null) return;
    args.push(...diffArgs);

    // Baseline mode: gate only on findings not already recorded in the baseline.
    // The CLI handles a missing file (warns, analyzes everything) and a corrupt
    // file (exits 2); we just resolve the path (absolute as-is, relative against
    // the workspace) and pass it through. Composes with diff mode.
    if (baselineInput && baselineInput.trim()) {
      args.push('--baseline', path.resolve(workspace, baselineInput.trim()));
    }

    // Opt-in telemetry: pass --telemetry so the run sends one anonymous usage
    // event (tool name, latency bucket, per-rule finding counts, hashed workspace
    // id) using the license the CLI already mints from the api-key. Off by
    // default; no source, paths, or code are ever sent.
    if (wantTelemetry) {
      args.push('--telemetry');
    }

    // CodeCharter loads the solution through MSBuild and locates a .NET SDK via
    // Microsoft.Build.Locator; without one it aborts. Warn early (advisory
    // only - the SDK may be discoverable via DOTNET_ROOT without being on PATH).
    const hasDotnet = (await io.which('dotnet', false)) || process.env.DOTNET_ROOT;
    if (!hasDotnet) {
      core.warning(
        'No .NET SDK detected on the runner. CodeCharter needs one to analyze the solution. ' +
          'What to do: add `- uses: actions/setup-dotnet@v4` (with your target `dotnet-version`) ' +
          'before this action if the analysis fails. See the action README, section "Requirements".'
      );
    }

    // Capture output so a missing-SDK crash can be turned into an actionable
    // message; exec still streams everything (including annotations) to the log.
    let output = '';
    const append = (data) => {
      output += data.toString();
    };
    const code = await exec.exec(exe, args, {
      env,
      ignoreReturnCode: true,
      listeners: { stdout: append, stderr: append },
    });

    // Report findings regardless of the exit code, so they still surface when
    // fail-on trips the gate (a non-zero exit with real findings).
    const report = readJson(jsonPath);
    if (report) {
      const counts = tally(report);
      core.setOutput('findings-total', counts.total);
      core.setOutput('findings-error', counts.error);
      core.setOutput('findings-warn', counts.warn);
      core.setOutput('findings-info', counts.info);
      if (sarifPath) core.setOutput('sarif-path', sarifPath);

      const repoFull = process.env.GITHUB_REPOSITORY || `${github.context.repo.owner}/${github.context.repo.repo}`;
      const sha = github.context.payload.pull_request?.head?.sha || github.context.sha;
      // Discriminate this run's comment so multiple CodeCharter steps in one PR
      // (different workflows/jobs/solutions, or an explicit comment-key) keep
      // separate comments. Stable across re-runs of the same logical job.
      // Use a workspace-relative, slash-normalized solution path so the marker
      // does not embed an absolute runner path: on self-hosted runners the same
      // job can land in different working directories (e.g. C:\runners\1 vs
      // C:\runners\3), which would otherwise yield a different marker each run
      // and post a duplicate comment instead of updating the existing one.
      const solutionKey = path.relative(workspace, path.resolve(workspace, solution)).split(path.sep).join('/');
      const discriminator =
        commentKey || [process.env.GITHUB_WORKFLOW, process.env.GITHUB_JOB, solutionKey].filter(Boolean).join(' / ');
      const titleSuffix = commentKey || solution;
      const markdown = buildComment(report, counts, workspace, {
        severityThreshold: severity,
        repoFull,
        sha,
        titleSuffix,
        failOn,
      });
      await writeSummary(markdown);

      // Prefer publishing as the CodeCharter App via the portal: a branded check
      // run + comment, no GitHub token on the runner and no pull-requests: write
      // needed. Fall back to the workflow-token comment when the App is not
      // installed/linked or the portal is unavailable, so repos without the App
      // keep working unchanged.
      const published = await publishViaPortal(
        portal,
        apiKey,
        withBadge(
          {
            repository: repoFull,
            headSha: sha,
            pullNumber: github.context.payload.pull_request?.number ?? null,
            checkName: titleSuffix ? `CodeCharter / ${titleSuffix}` : 'CodeCharter',
            conclusion: conclusionFor(failOn, counts),
            title: titleFor(counts),
            summary: markdown,
            annotations: [],
            comment: wantComment,
            commentKey: discriminator,
          },
          wantBadge,
          () => analysisBadgePayload(counts)
        )
      );

      if (!published && wantComment) {
        await upsertComment(githubToken, commentMarker(discriminator), markdown);
      }
    }

    if (code !== 0) {
      if (/Path to dotnet executable is not set|Microsoft\.Build\.Locator|MSBuildLocator/i.test(output)) {
        core.error(
          'CodeCharter could not find a .NET SDK on the runner (needed to load the solution via MSBuild). ' +
            'What to do: add a setup step before this action, e.g.:\n' +
            '      - uses: actions/setup-dotnet@v4\n' +
            "        with:\n          dotnet-version: '9.0.x'\n" +
            'See the action README, section "Requirements".'
        );
      } else if (
        /Lösungsdatei nicht gefunden|[Ss]olution file (was )?not found|could not (find|locate).{0,40}\.(sln|slnx|csproj)|\.(sln|slnx|csproj)["']?\s*(was )?not found/i.test(
          output
        )
      ) {
        core.error(
          `CodeCharter could not find the project file at the resolved path. The "solution" input was ` +
            `"${solution}". What to do:\n` +
            '      - Give a path RELATIVE to the repository root (e.g. `solution: samples/Samples.sln`), ' +
            'not an absolute path and not prefixed with ${{ github.workspace }}.\n' +
            '      - Or leave `solution` empty to auto-discover the first .sln/.slnx (or .csproj) in the repo.\n' +
            '      - Make sure the code is checked out before this step (actions/checkout) so the file exists.\n' +
            'See the action README, section "Inputs".'
        );
      }

      // fail-on: never means "report but never fail the build". The CLI has no
      // such level: omitting --fail-on makes it exit 1 on *any* violation. So a
      // non-zero exit that still produced a report is just findings — swallow it
      // here. A non-zero exit with no report is a real failure (crash, missing
      // SDK, license, download) and must propagate.
      if (failOn === 'never' && report) {
        core.info(`CodeCharter found ${tally(report).total} finding(s); not failing the build (fail-on: never).`);
      } else if (report) {
        // A report exists: the non-zero exit is the fail-on gate tripping on
        // findings, not a crash. Say so and how to change the threshold.
        const c = tally(report);
        core.setFailed(
          `CodeCharter found ${c.error} error / ${c.warn} warning / ${c.info} info finding(s) and the ` +
            `\`fail-on: ${failOn}\` gate failed the build. What to do: fix the findings above, or relax ` +
            '`fail-on` (`warn`, `info`, or `never`) to stop them from failing the build.'
        );
      } else {
        // No report: a real failure (crash, missing SDK, bad solution path,
        // license or download error). The specific cause was already surfaced
        // by the branches above when recognized; otherwise point at the log.
        const shown = code === null ? 'null (the CodeCharter process was terminated)' : code;
        core.setFailed(
          `CodeCharter failed (exit code ${shown}) without producing results. ` +
            'Check the messages above for the cause - common ones are a missing .NET SDK, ' +
            'an invalid `solution` path, or a license/download error.'
        );
      }
    }
  } finally {
    await io.rmRF(tmp);
  }
}

/**
 * True when this module is the process entry point (node dist/index.js on the
 * runner) rather than being imported from a test, so `run()` starts only in the
 * former case.
 *
 * A plain `import.meta.url === pathToFileURL(process.argv[1]).href` string
 * compare is too fragile: on a runner whose work directory is reached through a
 * junction/symlink (some self-hosted Windows runners expose the same tree as
 * both `C:\runner-cache\...` and `C:\github-runner\...`), Node resolves
 * `import.meta.url` to the realpath while `process.argv[1]` keeps the
 * unresolved path, so the two differ and the action silently no-ops — passing
 * the check without ever analyzing anything. Windows also varies the
 * drive-letter case between the two.
 *
 * So: take the fast exact-URL path first (the common Linux/macOS case, and a
 * safe fallback if realpath ever throws), then compare the canonical realpaths,
 * case-insensitively on Windows where the filesystem is case-insensitive.
 */
function isMainModule(moduleUrl, entryArg) {
  if (!entryArg) return false;
  if (moduleUrl === pathToFileURL(entryArg).href) return true;
  try {
    const self = fs.realpathSync(fileURLToPath(moduleUrl));
    const entry = fs.realpathSync(entryArg);
    return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  run().catch((err) => core.setFailed(err instanceof Error ? err.message : String(err)));
}

// Exported for unit tests. The pure helpers carry the action's logic (severity
// mapping, path normalization, comment rendering, gate decisions); exporting
// them lets the tests exercise every branch and edge case without spinning up
// the whole action.
export {
  run,
  runCoverage,
  coverageSummary,
  testCountsFor,
  testCountRows,
  floorPercent,
  buildBadgePayload,
  withBadge,
  coverageBadgePayload,
  analysisBadgePayload,
  buildCoverageComment,
  coverageFooterLine,
  coverageConclusion,
  coverageTitle,
  isMainModule,
  commentMarker,
  resolvePlatform,
  downloadArchive,
  verifySha,
  findExecutable,
  discoverSolutions,
  hasConfiguredProfiles,
  resolveDiffArgs,
  fetchManifest,
  obtainCli,
  publishViaPortal,
  upsertComment,
  writeSummary,
  readJson,
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
  buildComment,
  conclusionFor,
  titleFor,
  PLATFORMS,
  MAX_COMMENT_ROWS,
};
