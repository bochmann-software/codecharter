# Contributing

Thanks for helping improve the CodeGuard GitHub Action.

## Development

Prerequisites: Node.js 24+ (matches the action runtime).

```bash
npm ci            # install dependencies
npm run lint      # ESLint
npm run format    # apply Prettier (npm run format:check to verify only)
npm test          # run the test suite (node:test)
npm run build     # bundle src/ into dist/ with esbuild (ESM)
```

The action and its tests are ESM (`"type": "module"`). The GitHub Actions
toolkit (`@actions/*`) is ESM-only, so the toolkit is imported through
`src/deps.js`, which re-exports mutable copies the tests can stub.

### The `dist/` bundle

The action runs the committed `dist/index.js`, not `src/`. Whenever you change
anything under `src/`, run `npm run build` and commit the regenerated `dist/`
in the same PR. CI runs the build as a compile check.

Note: `dist/` is intentionally **not** byte-compared in CI — bundler output can
differ across operating systems and Node versions, so a strict diff would report
environment noise rather than real changes. The canonical bundle is rebuilt on
release by the release workflow.

## Commit and PR conventions

Commit messages and PR titles follow
[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>
```

`type` is one of `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.
Keep the subject short and imperative, with no trailing period. Example:

```
feat(diff): scope analysis to changed lines
```

PRs are squash-merged, so the squash commit message — not the intermediate
commits — is what lands on `main`; write it to describe the net change.

## Tests

Every behavioral change needs test coverage. Pure helpers are unit-tested
directly; integration-level wiring is covered by running the built bundle. CI
enforces coverage thresholds — see `.github/workflows/ci.yml`.
