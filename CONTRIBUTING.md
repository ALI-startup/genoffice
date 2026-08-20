# Contributing to SamuGen

Thanks for your interest in contributing. This document covers the local
setup, the checks a change must pass, and the conventions used in this
repository.

## How changes land here

This GitHub repository is a mirror: development happens in a private tree,
and `main` here advances through single squashed snapshot commits
(`Sync snapshot (<date>)`). That is why every file in a sync shows the same
last-commit message, and why nobody — maintainers included — pushes to
`main` directly.

External pull requests are welcome and are reviewed here. Once a change is
accepted, a maintainer imports it into the private tree with your authorship
preserved as a `Co-authored-by:` trailer, and it ships to `main` in the next
snapshot; your PR is then closed with a note pointing at the snapshot that
carried it. GitHub will show the PR as "closed" rather than "merged" — the
code and the attribution still land. Issues and feature requests are handled
directly on this repository as usual.

## Repository layout

- `apps/*` — the five browser apps (docs, sheets, slides, pdf, shell). Each is
  an npm workspace with `src/renderer` (the React UI), `src/renderer/host-web.ts`
  (the one module that touches a browser API, filled into the app's platform
  slot at boot), and `tests/`.
- `packages/*` — host-agnostic engine and shared packages, unit-tested:
  docx/pptx engines, AI agent core, providers, the platform ports and their web
  adapter, i18n, UI kit.
- `services/ai-bff` — the only server piece: it holds the provider credentials
  and proxies streaming AI calls, so no key reaches the page.
- `apps/sheets/native/xlsx-engine` — the Rust xlsx engine, compiled to
  WebAssembly for the browser and to a native binary the engine's reference
  tests and benchmarks drive.

## Getting started

Prerequisites: Node 22+ (the floor is real — Vite loads each app's TypeScript
config through `require(esm)`, which Node 20 cannot do), npm 10+, and a Rust
toolchain for the sheets engine (`cargo` on PATH, plus `clang` and `wasi-libc`
for its WebAssembly build).

```bash
npm install
npm run fixtures     # generate test .docx fixtures (one-time, and after docx-engine changes)
npm run dev          # everything: the four editors, the shell and the AI BFF
npm run docs:web     # or one app on its own
```

Open the shell at `localhost:5190`: the editors are reached through its origin,
which is what keeps their AI calls same-origin. **Chromium 86+** — the apps open
and save real files through the File System Access API.

## Checks every change must pass

CI runs these on every PR; please run them locally first:

```bash
npm run format:check # Prettier check for uncommitted changed/new files
npm run lint         # ESLint across the repo (0 errors required; warnings allowed)
npm run typecheck    # tsc --noEmit across every workspace
npm test             # engine + app unit tests (also runs the Rust engine's tests)
npm run licenses     # production dependency licenses within the permissive allowlist
```

The end-to-end suite is separate because it needs the built bundle:

```bash
npm run build:shell:web  # the composed bundle, shell plus the editors under /app/*
npm run test:e2e         # Chromium against it, served the way nginx serves it
```

Formatting is intentionally incremental: existing files are not reformatted
unless they are part of your change. Run these exact commands before committing:

```bash
npm run format                              # format uncommitted changed/new files
npm run format:check                        # verify uncommitted changed/new files
npm run format:check -- --base origin/main  # verify committed files on your branch
```

CI supplies the PR or push base automatically and checks only files changed from
that base. This keeps the formatter gate useful without creating a repository-wide
formatting diff.

## Deploying

There is nothing to package: `npm run build:shell:web` produces static files, and
`docker/docker.sh up` builds the two images that serve them — nginx over the
bundle, and the AI BFF, which is deliberately unpublished. `docker/nginx/app.conf.template`
is the reference configuration, including the one route that must be proxied
(`AI_BFF_BASE_PATH`) for the apps' `connect-src 'self'` to hold.

## Environment variables

None are required — the apps run with all of these unset. They exist for
testing and local overrides:

| Variable                                                 | Effect                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `*_WEB_PORT`, `*_WEB_BASE`, `*_WEB_OUT_DIR`              | Per-app dev port, base path and build output (set by the web scripts)  |
| `AI_BFF_URL`                                             | Where the dev servers proxy the AI route (default `127.0.0.1:8788`)    |
| `SERPER_API_KEY`                                         | Serper key for web/image search (DuckDuckGo is the keyless fallback)   |
| `WASI_SYSROOT`                                           | A wasi-sdk sysroot for the sheets WebAssembly build, if not on the box |
| `XLSX_SIDECAR_PATH`, `XLSX_OPEN_PATH`, `XLSX_DEBUG_PORT` | Point the engine's reference tests at a locally built native binary    |
| `E2E_WEB_PORT`, `E2E_CHROMIUM_PATH`                      | The E2E server's port, and a Chromium outside Playwright's own cache   |

AI features degrade rather than break without credentials: a request with no
configured provider reports that plainly, and web search falls back to a keyless
backend.

## Coding conventions

- **English only** in code, comments, commit messages, and docs. User-facing
  strings go through the i18n resources (`src/renderer/i18n/`), which are the
  only place non-English text belongs (plus test fixture text).
- TypeScript everywhere; avoid adding new `any` surfaces where a precise type
  is cheap.
- Tests live in `apps/*/tests` and `packages/*/tests` (vitest). New engine
  behavior needs a unit test; renderer-only UI tweaks generally don't.
- The pagination-fidelity baselines (`scripts/pagination-baseline-word.mjs`,
  which needs macOS with Microsoft Word and AppleScript permission, and
  `scripts/pagination-baseline.mjs`, which uses headless LibreOffice) are
  optional local tools and never run in CI.
- Keep files from growing without bound: if you are adding a substantial new
  concern to an already-large file, prefer a new module.

## Commit and PR guidelines

- Small, focused commits with imperative English subject lines
  (e.g. `fix docx table border round-trip`, `add slides chart legend parsing`).
- A PR should explain _why_ the change is needed, and mention which of the
  checks above you ran.
- File format fidelity is the core product promise: for changes touching
  open/save paths (docx/xlsx/pptx), include a round-trip test proving
  untouched content survives byte-for-byte.

## Reporting bugs and requesting features

Use the issue templates. For suspected security issues, do **not** open a
public issue — follow [SECURITY.md](SECURITY.md).

## Code of conduct

All community spaces follow the
[Contributor Covenant](CODE_OF_CONDUCT.md); participation implies acceptance.

## License and CLA

There is no CLA (contributor license agreement), and we do not plan to add
one. By contributing, you agree that your contributions are licensed under
the [Apache License 2.0](LICENSE) that covers this project — inbound =
outbound, per Apache-2.0 §5. Because community contributions keep their
Apache-2.0 terms, the open-source core cannot be retroactively relicensed.

The `ee/` directory is reserved for future enterprise modules under a
[separate license](ee/LICENSE) and does not accept external contributions —
pull requests from outside the maintainer team must not modify files under
`ee/` (enforced via [CODEOWNERS](.github/CODEOWNERS)).
