# CodeCharter GitHub Action

Run deterministic .NET code-quality analysis on every pull request. Reports
violations as native GitHub annotations directly on the diff.

CodeCharter is a commercial product by bochmann-software. Sign up for a free
30-day trial at <https://codecharter.tools>.

## Requirements

CodeCharter loads your solution through MSBuild and locates an installed **.NET
SDK** to do so (via `Microsoft.Build.Locator`); it does not bundle MSBuild. The
runner must therefore have a .NET SDK available. GitHub-hosted runners that you
prepare with `actions/setup-dotnet` (and most self-hosted .NET runners) satisfy
this; on a runner without an SDK the analysis fails with `Path to dotnet
executable is not set`. Add `actions/setup-dotnet` before this action, matching
your solution's target framework.

## Usage

```yaml
name: CodeCharter
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write   # only needed for the PR summary comment

jobs:
  codecharter:
    runs-on: ubuntu-latest   # or self-hosted, windows-latest, macos-latest
    if: github.event.pull_request.draft == false
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '9.0.x'   # match your solution's target framework
      - uses: bochmann-software/codecharter@v1
        with:
          solution: MyApp.sln
          fail-on: error
          api-key: ${{ secrets.CODECHARTER_API_KEY }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `mode` | no | `analyze` | What this step runs: `analyze` for the rule analysis, `coverage` for the test-coverage gate (see below). The coverage inputs are listed at the end of this table |
| `solution` | no | `''` (auto-discover) | Path to `.sln`, `.slnx`, or `.csproj` relative to the repo root. Leave empty to auto-discover (see below) |
| `api-key` | yes | — | Your CodeCharter portal API key (see Setup) |
| `rules` | no | `''` (auto) | Path to a local rules directory in your repo (e.g. `rules`). Leave empty to let the CLI use a `.codecharter/config.yml` profile and/or a `rules/` directory in the repo root if present, otherwise its bundled sample rules |
| `require-rules` | no | `false` | Fail the run instead of falling back to the CLI's bundled sample rules when there is no rule source at all — no `rules` input, no `rules/` directory, and no `profiles:` in `.codecharter/config.yml`. A warning is logged on the bundled fallback regardless |
| `fail-on` | no | `error` | Fail the run when violations reach this level (`error`, `warn`, `info`, `never`) |
| `severity-threshold` | no | `info` | Minimum severity to report and annotate |
| `diff` | no | `false` | Scope analysis to changed lines only (see below). `true` diffs a PR against its base branch; also accepts a git ref range (e.g. `main..HEAD`) or a path to a unified diff file |
| `baseline` | no | `''` | Path to a committed baseline file of accepted findings (see below). When set, only findings not in the baseline are reported and gated, so existing findings are tolerated and only new ones fail |
| `telemetry` | no | `false` | Opt-in: send one anonymous usage event per run (tool name, latency bucket, per-rule finding counts, hashed workspace id) to the CodeCharter endpoint. Off by default; no source, paths, or code are ever sent |
| `badge` | no | `false` | Opt-in: attach the run's aggregate numbers (coverage percent and line totals, finding counts by severity, test counts) plus the branch to the authenticated check report, so the portal can serve repository badges (see below). Nothing is stored otherwise. Valid in both modes |
| `version` | no | `latest` | CLI version selector — `latest`, `v1`, `v1.4`, or an exact pin like `v1.4.2` |
| `portal-base-url` | no | `https://codecharter.tools` | Override only for self-hosted or staging deployments |
| `comment` | no | `true` | Post and update a sticky summary comment on the PR (needs `pull-requests: write`). Set `false` for annotations only |
| `cache` | no | `true` | Cache the downloaded CLI binary between runs (Actions cache) to skip re-downloading it. Set `false` to always download. Caching is skipped automatically (with a warning) on runners that have neither `zstd` nor `gzip` on PATH, since the Actions cache needs one to compress entries |
| `comment-key` | no | `''` (auto) | Discriminator for the sticky PR comment. Auto-derived from workflow + job + solution so multiple CodeCharter runs in one PR keep separate comments; set explicitly to control sharing (e.g. a matrix dimension) |
| `sarif-output` | no | `''` | If set, also write a SARIF file to this path for GitHub Code Scanning |
| `github-token` | no | `${{ github.token }}` | Token used to post the PR comment |
| `coverage-root` | no | `''` (repo root) | Coverage mode only. Directory tree searched for test projects |
| `min-coverage` | no | `''` (repo config) | Coverage mode only. Minimum required line coverage (0-100), e.g. `99.5`. Overrides `coverage.minimum-percent` from `.codecharter/config.yml` for this run |
| `skip-tests` | no | `false` | Coverage mode only. Analyze the coverage files already present under the results root instead of running the tests |
| `results-root` | no | `''` (CLI default) | Coverage mode only. Directory for test and coverage artifacts |
| `fail-on-threshold` | no | `true` | Coverage mode only. Set `false` to report coverage below the minimum without failing the step. Failing tests, missing data and config errors still fail |
| `coverage-report` | no | `''` | Coverage mode only. Path to write the JSON coverage report to, for later steps to upload or post-process |

### Coverage gate (`mode: coverage`)

`mode: coverage` runs the CLI's test-coverage gate instead of the rule analysis:
it discovers the test projects under `coverage-root`, runs them with coverage
collection, and fails the step when line coverage is below the required minimum.
The threshold comes from `.codecharter/config.yml` unless `min-coverage`
overrides it, so raising the bar is a repo change, not a workflow change.

Every test project needs the `coverlet.collector` package; a project without it
runs its tests but produces no coverage data, and the run says so per project.

```yaml
- uses: actions/setup-dotnet@v4
  with:
    dotnet-version: '9.0.x'

- uses: bochmann-software/codecharter@v1
  with:
    mode: coverage
    api-key: ${{ secrets.CODEGUARD_API_KEY }}
```

The step posts the same sticky summary as the analysis mode, listing every
uncovered region with its file, line range and containing method. Analysis and
coverage are separate steps (or jobs), so each keeps its own comment and check.

The summary also carries a test table with one row per test project — the
project name, whether it passed, and (with CLI v1.4.5 and newer)
`Tests | Passed | Failed | Skipped`. Failing projects are listed first, with the
reason the CLI gave, for example `timed out after 1800s`. Older CLIs report no
counts, so those rows show em-dashes instead of numbers. The last row is always
the total summed over the projects that reported counts. On a repository with
very many test projects the table shrinks to fit GitHub's comment size limit:
first the passing rows drop (noting how many were left out), and if that is
still not enough only the totals row remains.

Exit codes map onto the step result: coverage below the minimum fails unless
`fail-on-threshold: false`, while failing tests, incomplete or missing coverage
data and configuration errors always fail — the gate is fail-closed and never
reports a pass it could not verify.

### Solution auto-discovery

When `solution` is left empty, the action scans the checked-out repository and
picks one project to analyze. It prefers solution files: if any `.sln` or
`.slnx` exists, it analyzes the first one; otherwise it falls back to the first
`.csproj`. "First" means the shallowest directory wins, ties broken
alphabetically, so the choice is stable across runs. `node_modules`, `bin`,
`obj`, and `.git` are skipped. If several candidates are found, the action logs
a warning listing them — set `solution` explicitly to remove the ambiguity.

A relative path (e.g. `samples/Samples.sln`) is recommended, but an absolute
path or one prefixed with `${{ github.workspace }}` is also accepted and
resolved correctly.

### Rules resolution

When `rules` is set, that directory is passed to the CLI as `--rules` and must
exist (a missing directory is a hard error). When `rules` is left empty, the CLI
resolves rules itself: it runs any [profiles](#profiles-rule-sets-managed-in-the-portal)
declared in `.codecharter/config.yml`, and/or a `rules/` directory in the
repository root if one exists. Only when none of those is present does it fall
back to the sample rules bundled with the CLI.

That bundled-rules fallback is convenient for a first run but rarely what an
established project wants, so the action logs a warning whenever it would happen
— that is, only when there is no rule source at all. A repository that pins a
profile in `.codecharter/config.yml` is a fully configured rule source, so no
warning is logged and `require-rules: true` does not fail. Set
`require-rules: true` to turn the bundled fallback into a hard failure instead —
useful to guarantee a pipeline only ever runs against your own committed rules or
a pinned profile.

### Profiles (rule sets managed in the portal)

Besides a local `rules/` directory, you can assemble rule sets as **profiles** in
the CodeCharter portal and consume them from CI. Profiles are versioned in the
portal; CI pins an exact version and restores the rules automatically — no new
action input is required, and the rules are applied **in addition to** whatever
the [rules resolution](#rules-resolution) above turns up.

Two files, both committed **next to the solution** (the same directory as the
`.sln`/`.slnx`/`.csproj` that `solution` points to, or that auto-discovery
picks):

1. `codecharter.yml` — lists the profiles to apply:

   ```yaml
   profiles:
     - dotnet-base@1.4.2          # slug@major.minor.patch (exact version)
     - my-org/security@2.0.1      # optionally org-scoped
   ```

   Versions are pinned exactly. Platform profiles (a `codecharter/…` prefix) are
   not available yet.

2. `codecharter.lock.json` — generated by running `codecharter update` locally once
   (and again whenever you change `codecharter.yml`). It records the resolved
   bundle URL and a content hash per profile so CI restores exactly the bytes you
   resolved. Commit it alongside `codecharter.yml`.

On each run the action's `codecharter analyze` reads the lockfile and restores the
profile rule bundles into `<solution-dir>/.codecharter/cache` before analyzing.
That cache is rebuilt from the portal on demand, so **do not commit it** — add
`**/.codecharter/cache/` to `.gitignore`.

The restore authenticates with the same short-lived license the CLI already
mints from your `api-key`, so nothing beyond the existing `CODECHARTER_API_KEY`
secret is needed on the runner — the long-lived key never leaves the mint step.
A run fails fast with an actionable message if `codecharter.yml` lists profiles but
the lockfile is missing or stale (run `codecharter update`), or if the portal is
unreachable on a cold cache.

This requires a recent CodeCharter CLI; the default `version: latest` satisfies it.

### Diff mode (changed lines only)

The `diff` input scopes the run to only changed lines — both the reported
findings and the `fail-on` gate then apply to those lines only, so a PR fails
only on issues it introduces. The single value is interpreted by content:

| `diff` value | Behavior |
|---|---|
| `false` (default) | Analyze the whole solution. |
| `true` | On pull requests, diff against the base branch (`merge-base..head`). Ignored on non-PR events. |
| a git ref range, e.g. `main..HEAD` | Diff that range. |
| a path to a unified diff file | Use that diff as-is. |

The diff is computed on the runner, so check out enough history for the compared
commits:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: bochmann-software/codecharter@v1
  with:
    solution: MyApp.sln
    fail-on: error
    diff: true              # only analyze lines changed by the PR
    api-key: ${{ secrets.CODECHARTER_API_KEY }}
```

This requires a CodeCharter CLI with diff support (`version: latest`, the default,
satisfies it).

### Baseline gate (new findings only)

Where diff mode scopes by changed lines, baseline mode scopes by finding
identity: accept today's findings as a baseline, then fail only on findings that
are not in it — ideal for adopting CodeCharter on an existing codebase. Generate
the baseline once with the CLI and commit it:

```bash
codecharter analyze MyApp.sln --write-baseline .codecharter/baseline.json
git add .codecharter/baseline.json && git commit -m "chore: codecharter baseline"
```

Then point the action at it:

```yaml
- uses: bochmann-software/codecharter@v1
  with:
    solution: MyApp.sln
    fail-on: error
    baseline: .codecharter/baseline.json   # only new findings fail
    api-key: ${{ secrets.CODECHARTER_API_KEY }}
```

A missing baseline file analyzes everything (with a warning); a corrupt file
fails the run. `baseline` composes with `diff`. Requires a CLI with baseline
support (`version: latest`, the default, satisfies it). To accept newly
introduced findings later, regenerate the file with `--write-baseline` and commit
it.

### Telemetry (opt-in)

Set `telemetry: true` to send one anonymous usage event per run — tool name,
latency bucket, per-rule finding counts, and a hashed workspace id. It is **off
by default** and never sends source, file paths, or code. Authentication uses
the same short-lived license the CLI already mints from your `api-key`, so no
extra secret is needed.

```yaml
- uses: bochmann-software/codecharter@v1
  with:
    solution: MyApp.sln
    telemetry: true
    api-key: ${{ secrets.CODECHARTER_API_KEY }}
```

Requires a CLI with telemetry support (`version: latest`, the default, satisfies
it).

### Repository badges (opt-in)

Set `badge: true` to let the portal serve a coverage or findings badge for the
repository. It is **off by default**: without it the check report the action
already posts carries no numbers to store, and the portal has nothing to render
a badge from.

```yaml
- uses: bochmann-software/codecharter@v1
  with:
    mode: coverage
    badge: true
    api-key: ${{ secrets.CODECHARTER_API_KEY }}
```

What gets attached are aggregates only — never source, file paths, or code:

| Field | Filled by | Contents |
|---|---|---|
| `branch` | both modes | The branch the run measured, and whether it is the repository's default branch |
| `coverage` | coverage mode | Percent (truncated to two decimals, so 99.999% never shows as 100%), required percent, whether the gate was met, covered and measurable lines |
| `testCounts` | coverage mode | Total, passed, failed and skipped tests, summed over the test projects that report counts (CLI v1.4.5+); absent for older CLIs |
| `findings` | analyze mode | Number of error, warning and info findings |

The numbers travel inside the existing authenticated `POST` to the portal, so no
extra secret or permission is needed. Enable the badge for the repository in the
portal (**Repository → Badges**), which yields the badge URL and a Markdown
snippet to paste into your README. The badge shows the last run on the default
branch, so keep `badge: true` on the workflow that runs there. Turning the
toggle off in the portal stops serving the badge; turning the input off stops
sending the numbers in the first place.

## Outputs

| Output | Description |
|---|---|
| `findings-total` | Total number of findings |
| `findings-error` | Number of error-level findings |
| `findings-warn` | Number of warning-level findings |
| `findings-info` | Number of info-level findings |
| `sarif-path` | Path to the generated SARIF file, if `sarif-output` was set |
| `coverage-percent` | Coverage mode: line-coverage percent; empty when no coverage data was produced |
| `coverage-met` | Coverage mode: `"true"` when coverage met the required minimum |
| `coverage-uncovered-regions` | Coverage mode: number of uncovered regions in the report |
| `coverage-report-path` | Coverage mode: path to the JSON report, if `coverage-report` was set |

## How it works

The action downloads the platform-matching CodeCharter CLI archive from the
portal, verifies its SHA-256 against the `X-CodeCharter-Sha256` header, extracts
it, and runs `codecharter analyze` once. From that single run it emits GitHub's
native annotations (findings appear inline on the "Files changed" tab), a
machine-readable JSON report used to set the outputs above and a sticky PR
summary comment, and — when `sarif-output` is set — a SARIF file for Code
Scanning. Disable the comment with `comment: false` to keep annotations only.

### Branded checks via the CodeCharter App (recommended)

If you install the **CodeCharter GitHub App** on your repository (and link it to
your CodeCharter account in the portal), the action publishes the results through
the portal as the App: a branded **CodeCharter** check run plus the sticky
comment, posted under the App's identity. In that case **no GitHub token is used
on the runner and `pull-requests: write` is not required** — the App carries the
permissions. If the App is not installed/linked (or the portal is unreachable),
the action transparently falls back to the workflow-token comment described
below, so nothing breaks.

### Comment via the workflow token (fallback)

The PR comment needs `permissions: pull-requests: write` on the job (or
workflow); without it the action logs a warning and skips the comment while
annotations and the job summary still work. If you run CodeCharter more than once
in the same PR (several workflows, jobs, or solutions), each run keeps its own
comment automatically — the comment is keyed by workflow + job + solution, so
they never overwrite one another. Override that grouping with `comment-key`.
The single-run multi-output requires CodeCharter CLI **v1.0.6 or newer** (the
default `version: latest` satisfies this).

The downloaded CLI binary is cached between runs via the Actions cache
(`cache: true`), so only the first run on a fresh cache pays the download. The
cache is keyed by the **concrete** version: for a moving selector (`latest`,
`v1`, `v1.4`) the action first resolves it to the actual release via a
lightweight portal lookup, then caches under that version. A run reuses the
cache as long as the resolved version is unchanged, and picks up a new release
immediately (no daily delay); exact pins (e.g. `1.4.2`) are cached indefinitely
without any lookup. If the portal does not support the lookup (older
deployment), the action falls back to a per-day key. Only the generic binary is
cached — the short-lived license is never cached. On runners without an Actions
cache service the action simply downloads each run.

It is a JavaScript action that runs on the runner's bundled Node.js, so there
is nothing to install: no Docker container, no container registry, and no
PowerShell or other shell prerequisite. Works identically on `ubuntu-latest`,
`windows-latest`, `macos-latest`, and any self-hosted Linux, Windows, or macOS
runner.

### Licensing — nothing long-lived on the runner

The API key is the **only** long-lived secret. The CLI itself mints a
short-lived (24-hour) license from it at startup, fetching it from the portal
with the API key as the sole credential — the action never stores a permanent
license file on the runner. The minted license is written to an ephemeral
directory and deleted together with the CLI binary when the run finishes, so
even on persistent self-hosted runners nothing licensing-related lingers.

Security properties this gives you:

- A leaked cached license expires on its own within 24 hours.
- Revoking the API key in the portal disables every derived license within
  ≤ 24 hours, with no signing-key rotation.
- A cancelled subscription propagates to CI within ≤ 24 hours (the mint
  endpoint does an active-subscription preflight).

This requires CodeCharter CLI **v1.0.3 or newer** (the default `version: latest`
always satisfies this). Offline or air-gapped self-hosted runners cannot reach
the portal to mint a license — drop a full `codecharter.license` on the runner
instead and pin `version: local`.

## Setup

1. Sign in to <https://codecharter.tools> (or sign up for a
   trial).
2. Go to **API Keys → Generate key**, give it a name like
   `GitHub Actions — myrepo`.
3. Copy the cleartext token — it is only shown once.
4. In your CI repo, add a repository or organization secret named
   `CODECHARTER_API_KEY` with the token value.
5. Paste the workflow snippet above into `.github/workflows/codecharter.yml`.

Trial keys are valid for 30 days. Paid-subscription keys are valid for as
long as the subscription runs.

## Where findings appear

The action uses GitHub's native annotations API. Violations appear:

- Inline on the "Files changed" tab of the PR
- In the Checks tab as a check run with a summary title
- As a status check that blocks merging when `fail-on` is triggered (default
  is `error`)

By default the action also posts a sticky PR summary comment (see
[How it works](#how-it-works)); set `comment: false` to rely on the inline
annotations only.

## Versioning

- `@v1` — latest in the v1 line (recommended default — minor and patch updates
  roll in automatically)
- `@v1.4` — latest patch in v1.4
- `@v1.4.2` — exact pin
- `@main` — bleeding edge, not recommended for production

## License

CodeCharter is a commercial product by bochmann-software. This action is
proprietary; use is governed by the CodeCharter Terms of Service and requires a
valid subscription or trial. See [LICENSE](LICENSE) for the full terms.
