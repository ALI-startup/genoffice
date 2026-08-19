# GenOffice

An AI-native office suite: word processor, spreadsheet, presentations, and PDF
— five apps sharing one engine layer, built around AI editing as a first-class
workflow rather than a bolted-on chat box.

One codebase, two hosts. The same apps ship as a signed macOS/Windows desktop
suite and run in a browser with no Electron and no server-side document
processing — including the spreadsheet's Rust engine, compiled to WebAssembly.
See [Run it in a browser](#run-it-in-a-browser).

[![Meet GenOffice — the world's first full-featured open-source AI Office (video)](https://img.youtube.com/vi/B2pLdMX95v4/maxresdefault.jpg)](https://www.youtube.com/watch?v=B2pLdMX95v4)

[Watch the demo video on YouTube](https://www.youtube.com/watch?v=B2pLdMX95v4)

## Download

Signed installers built from `main`:

- **macOS** (Apple Silicon): [GenOffice-0.5.1-arm64.dmg](https://github.com/genspark-ai/genoffice/releases/download/v0.5.1/GenOffice-0.5.1-arm64.dmg)
- **Windows** (x64): [GenOfficeSetup-v0.5.1.exe](https://github.com/genspark-ai/genoffice/releases/download/v0.5.1/GenOfficeSetup-v0.5.1.exe)

Previous version:

- **macOS** (Apple Silicon): [GenOffice-0.4.110-arm64.dmg](https://github.com/genspark-ai/genoffice/releases/download/v0.4.110/GenOffice-0.4.110-arm64.dmg)
- **Windows** (x64): [GenOfficeSetup-v0.4.110.exe](https://github.com/genspark-ai/genoffice/releases/download/v0.4.110/GenOfficeSetup-v0.4.110.exe)

Other versions are on the [Releases](https://github.com/genspark-ai/genoffice/releases) page.

## Apps

| App           | Product              | What it is                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/docs`   | **GenOffice Docs**   | `.docx` word processor. Byte-preserving round trip: only dirty paragraphs are regenerated (paragraph patch), everything else in the original file is kept byte-for-byte, so opening and saving never breaks layout in Word. Paginated view whose line metrics reproduce the original document's layout, tracked changes, comments, styles, equations, ink.                                                                               |
| `apps/sheets` | **GenOffice Sheets** | `.xlsx` spreadsheet. UI built on the open-source [Univer](https://github.com/dream-num/univer) core (Apache-2.0) with a large layer of in-house extensions; xlsx import/export runs through an in-house Rust engine (calamine + IronCalc) — a sidecar process on the desktop, the same crate as WebAssembly in a browser; charts are rendered in-house (Konva), plus pivot tables, slicers, conditional formatting, and formula tracing. |
| `apps/slides` | **GenOffice Slides** | `.pptx` presentations. In-house pptx parse/render/edit engine with masters, charts, cropping, ink, and text shaping (HarfBuzz metrics on the desktop; the browser's own text engine on web).                                                                                                                                                                                                                                             |
| `apps/pdf`    | **GenOffice PDF**    | PDF viewer/editor on pdf.js + pdf-lib: annotations, forms, outlines, stamps, signatures, page operations, print.                                                                                                                                                                                                                                                                                                                         |
| `apps/shell`  | **GenOffice**        | The suite shell and landing page: home screen, tabbed hosting of the four editors, auto-update. On the desktop the tabs are `WebContentsView`s; in a browser they are same-origin iframes under `/app/docs/`, `/app/pdf/`, `/app/slides/` and `/app/sheets/`.                                                                                                                                                                            |

Every app embeds the same AI panel: block-granular AI editing with version
snapshots and diffs in docs, a tool-calling agent over workbook/slide/PDF
state in the others.

**AI providers.** Twenty-two of them, chosen in Settings ▸ AI providers:
Genspark (the default, signed in with a Genspark account), the major hosted
models, OpenAI-compatible endpoints, and local runtimes (Ollama, LM Studio,
vLLM, llama.cpp). On the desktop an API key is encrypted with the OS credential
store (Electron `safeStorage`) and is never read back into the settings page. In
a browser no key is held by the page at all: calls go through
`services/ai-bff`, which keeps the credentials server-side.

**Languages.** Nineteen, and every app's chrome carries an English ⇄ Korean
toggle at the end of its ribbon tab row — the shell's is on the tab strip and in
Settings ▸ General. Switching in any window applies everywhere: on the desktop
over IPC, in a browser through a storage event to every open tab and frame. The
full nineteen-language list is on the home page's account menu.

## Run it in a browser

Two ways, and they publish different ports. In both the **shell is the landing
page**: home, the tab strip, and every editor hosted as a same-origin frame of
its origin. The standalone ports serve one app each, no tab strip — same bundle,
different entry.

```bash
npm run shell:web    # landing page + all four editors + the AI BFF
npm run docs:web     # one app standalone (same pattern per app)
./docker/docker.sh up  # all five as containers
```

| App              | `npm run …` (Vite)              | Containers       |
| ---------------- | ------------------------------- | ---------------- |
| **Landing page** | `shell:web` → `localhost:5190`  | `localhost:8080` |
| **Docs**         | `docs:web` → `localhost:5183`   | `localhost:9081` |
| **Sheets**       | `sheets:web` → `localhost:5184` | `localhost:9084` |
| **Slides**       | `slides:web` → `localhost:5185` | `localhost:9083` |
| **PDF**          | `pdf:web` → `localhost:5186`    | `localhost:9082` |

Under `shell:web` the four editors are reached through the landing page's own
origin, so 5190 is the one to open. Every port is overridable (`SHELL_WEB_PORT`
… / `GENOFFICE_SHELL_PORT` …), and `strictPort` is set so a busy port fails
loudly instead of moving.

**Chromium 86+**, because the apps open and save real files through the File
System Access API rather than uploading them; there is no server that sees a
document. The AI BFF is the one server piece, it holds only provider
credentials, and in Docker it is deliberately unpublished.

Some capabilities are deliberately absent in a browser rather than stubbed —
PDF export from docs, Genspark sign-in, AI web search. `docs/web-migration.md`
§8 lists them, and §2.1 explains why a missing capability is `null` at the seam
instead of a stub that fails at the call site.

## Engine packages

All pure TypeScript, no Electron dependency, unit-tested (except the UI kit):

- `packages/docx-engine` — docx parsing → block tree (with `docxIndex`
  anchors and passthrough), OOXML fragment generation, byte-level paragraph
  patching.
- `packages/pptx-engine` / `packages/pptx-render` — pptx model and rendering.
- `packages/pdf-edit` — host-agnostic PDF editing (pdf-lib) with byte I/O
  injected, so Electron and the browser share one implementation.
- `packages/hwpx-convert` — HWPX import/export codecs.
- `packages/file-parse` — text extraction for AI attachments (office formats,
  text formats).
- `packages/platform` — the capability-scoped port interfaces both hosts
  implement, with `packages/platform-electron` and `packages/platform-web` as
  the two adapters. A build-time `@host` alias picks one, so a desktop bundle
  carries no browser code and a web bundle no `window.desktopApi`.
- `packages/agent-core` — the AI agent loop and skill composition shared by
  every app.
- `packages/ai-provider` / `packages/ai-electron` — provider abstraction and
  streaming, and the main-process settings + encrypted credential store.
- `packages/ai-search` — Genspark auth + web/image search tools.
- `packages/i18n`, `packages/ui`, `packages/project-store`,
  `packages/electron-utils` — shared i18n core, React UI kit, recent-files
  store, and Electron main-process helpers.
- `services/ai-bff` — the browser's backend-for-frontend: it holds the provider
  credentials and proxies streaming calls, so no key reaches the page.

## Development

```bash
npm install
npm run fixtures     # generate test .docx fixtures
npm test             # engine + app unit tests (docs/sheets/slides need no display)
npm run typecheck    # tsc --noEmit across every workspace
npm run lint         # eslint

npm run dev          # desktop: all four editors + shell against Vite dev servers
npm run dev:docs     # a single app (same pattern works per workspace)
npm run dist:mac     # package macOS dmg (regenerates third-party notices)
npm run dist:win     # package Windows nsis installer

npm run shell:web        # browser: landing page + all four editors + the BFF
npm run build:shell:web  # the composed web bundle the container image serves
```

The sheets app needs a Rust toolchain for its xlsx engine (`cargo` on PATH).
`npm run build -w @genoffice/sheets` compiles the desktop sidecar; the browser
build additionally needs the `wasm32-wasip1` target and a WASI sysroot, and
`npm run wasm:build -w @genoffice/sheets` produces the module (the web and
Docker build scripts run it for you). Tests that need the module skip loudly
when it has not been built.

Local UI/e2e driver scripts (Playwright + Electron, for local acceptance, not
committed by default) live in [`scripts/drivers/`](scripts/drivers/README.md).

## Architecture notes (docx round trip)

```
open docx ─► archive original by hash (never touched)
          ─► docx-engine parses word/document.xml top-level elements (w:p / w:tbl / …)
          ─► Block tree, each block anchored by docxIndex + original XML slice
          ─► TipTap streaming editor (manual + AI editing, dirty tracking)
save      ─► dirty blocks → OOXML fragments (referencing existing styles only)
          ─► splice into original document.xml (untouched blocks keep original bytes)
          ─► repack zip; all other entries copied byte-for-byte
```

The same philosophy holds in sheets and slides: the original file is the
source of truth, edits are applied as narrow patches, and everything the
editor didn't touch survives the round trip untouched.

None of that changes between hosts. What differs is where the bytes come from
and where they go — `node:fs` on the desktop, File System Access in a browser —
which is exactly what the platform ports abstract. Sheets is the sharpest case:
the same Rust crate is a child process over stdio on the desktop and a
WebAssembly module in a Worker in the page, answering the same JSON protocol, so
a saved workbook is byte-identical either way. `docs/web-migration.md` is the
long-form account.

## Security

See [SECURITY.md](SECURITY.md) for the process security posture (renderer
sandboxing, IPC validation, external-link gating) and the threat models for
AI-generated content.

## Third-party notices

`npm run notices` regenerates the bundled third-party license summary
(`tools/gen-third-party-notices.mjs`); all runtime dependencies are
MIT/Apache-2.0/OFL, and the bundled fonts (Liberation, Carlito, Caladea, Noto
CJK subsets) are OFL/Apache.

## License

GenOffice is licensed under the [Apache License 2.0](LICENSE), with one
exception: the `ee/` directory is reserved for future enterprise modules and
is covered by the [GenOffice Enterprise License](ee/LICENSE).

The GenOffice and Genspark names and logos are trademarks of Mainfunc, Inc.
The Apache-2.0 license does not grant permission to use them (see section 6);
forks should use their own branding.
