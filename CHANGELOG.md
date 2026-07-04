# Changelog

All notable changes to this action are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[semantic versioning](https://semver.org/). The major version tag (`v1`) tracks
the latest release in its line.

## [Unreleased]

## [1.7.3] - 2026-07-03

### Fixed

- The "no rules configured" warning (and the `require-rules: true` failure) no
  longer fires when the repository pins a platform profile in
  `.codeguard/config.yml`. The rule-source probe now recognises a non-empty
  `profiles:` list — block- or flow-style — as a valid rule source, matching what
  the CLI actually runs. Previously the action checked only the `rules` input and
  a `rules/` directory, so a profile-only setup was wrongly warned about as
  falling back to the CLI's bundled sample rules.

## [1.7.2] - 2026-07-03

### Fixed

- Detect the action's entry point through junctions/symlinks and drive-letter
  case differences. On self-hosted Windows runners that expose the work tree
  through a junction (e.g. both `C:\runner-cache\...` and `C:\github-runner\...`),
  Node resolved `import.meta.url` to the realpath while `process.argv[1]` kept
  the unresolved path, so the entry-point check failed and the action silently
  did nothing while still passing the check. The check now compares canonical
  realpaths (case-insensitively on Windows), so the action runs reliably on
  Windows, macOS and Linux.

## [1.7.1] - 2026-06-13

### Changed

- CLI caching now keys the Actions cache by the concrete resolved version. For a
  moving selector (`latest`, `v1`, `v1.4`) the action resolves it via the
  portal's manifest endpoint and caches under the actual version, so a new
  release is picked up immediately instead of after a day, and an unchanged
  version is never re-downloaded. Falls back to the previous per-day key when the
  endpoint is unavailable.

## [1.7.0] - 2026-06-13

### Added

- Unit and integration test suite (`node:test`) covering the action's helpers
  and the built bundle.
- CI workflow: lint, formatting check, tests with coverage thresholds, and a
  cross-platform matrix (Ubuntu, Windows, macOS).
- ESLint, Prettier and `.editorconfig`; `engines.node >= 24`.
- Dependabot for npm and `github-actions` dependencies.
- Marketplace branding, `CONTRIBUTING.md`, a pull-request template and this
  changelog.
- `LICENSE` file with the proprietary terms.

### Changed

- The action now runs on the Node.js 24 runtime (was Node.js 20).
- Migrated the codebase to ES modules and upgraded the `@actions/*` toolkit to
  its latest (ESM-only) majors. The bundle is now built with esbuild instead of
  ncc. No change to inputs, outputs or behavior.

### Fixed

- Escape backslashes before pipes when rendering rule names in the PR comment,
  so a backslash cannot break the Markdown table (CodeQL `js/incomplete-sanitization`).

## [1.6.7] and earlier

See the [GitHub Releases](https://github.com/bochmann-software/codeguard/releases)
page for the history of the `1.6.x` and earlier lines.

[Unreleased]: https://github.com/bochmann-software/codeguard/compare/v1.7.3...HEAD
[1.7.3]: https://github.com/bochmann-software/codeguard/compare/v1.7.2...v1.7.3
[1.7.2]: https://github.com/bochmann-software/codeguard/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/bochmann-software/codeguard/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/bochmann-software/codeguard/compare/v1.6.7...v1.7.0
[1.6.7]: https://github.com/bochmann-software/codeguard/releases/tag/v1.6.7
