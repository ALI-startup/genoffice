# SamuGen

An AI-native office suite for the browser: word processor, spreadsheet,
presentations, and PDF — five apps sharing one engine layer, built around AI
editing as a first-class workflow rather than a bolted-on chat box.

It runs entirely in the page. No Electron, no application server, and no
server-side document processing — the spreadsheet's Rust engine is compiled to
WebAssembly and the files never leave the machine. The one server piece is the AI
backend-for-frontend, and all it holds is provider credentials. See
[Running it](#running-it).

[Demo video for GenOffice](https://www.youtube.com/watch?v=B2pLdMX95v4), the
upstream project this is forked from — the editors it shows are the same ones
here, under the branding that came before.

## Apps

| App           | Product            | What it is                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/docs`   | **SamuGen Docs**   | `.docx` word processor. Byte-preserving round trip: only dirty paragraphs are regenerated (paragraph patch), everything else in the original file is kept byte-for-byte, so opening and saving never breaks layout in Word. Paginated view whose line metrics reproduce the original document's layout, tracked changes, comments, styles, equations, ink.                                               |
| `apps/sheets` | **SamuGen Sheets** | `.xlsx` spreadsheet. UI built on the open-source [Univer](https://github.com/dream-num/univer) core (Apache-2.0) with a large layer of in-house extensions; xlsx import/export runs through an in-house Rust engine (calamine + IronCalc) compiled to WebAssembly and driven in a Worker; charts are rendered in-house (Konva), plus pivot tables, slicers, conditional formatting, and formula tracing. |
| `apps/slides` | **SamuGen Slides** | `.pptx` presentations. In-house pptx parse/render/edit engine with masters, charts, cropping, ink, and text shaping on the browser's own text engine.                                                                                                                                                                                                                                                    |
| `apps/pdf`    | **SamuGen PDF**    | PDF viewer/editor on pdf.js + pdf-lib: annotations, forms, outlines, stamps, signatures, page operations, print.                                                                                                                                                                                                                                                                                         |
| `apps/shell`  | **SamuGen**        | The suite shell and landing page: home screen and tabbed hosting of the four editors, which are same-origin iframes under `/app/docs/`, `/app/pdf/`, `/app/slides/` and `/app/sheets/`.                                                                                                                                                                                                                  |

Every app embeds the same AI panel: block-granular AI editing with version
snapshots and diffs in docs, a tool-calling agent over workbook/slide/PDF
state in the others.

**AI providers.** Twenty-one of them, chosen in Settings ▸ AI providers: the
major hosted models (Claude, Gemini, OpenAI, DeepSeek, xAI…), OpenAI-compatible
endpoints, image providers (Runware, Replicate, fal, Stability), and local
runtimes (Ollama, LM Studio, vLLM, llama.cpp). There is no built-in account and
no privileged provider — you bring your own endpoint or key. No key is ever held
by the page: calls go through `services/ai-bff`, which keeps the credentials
server-side and returns only a masked summary to the settings screen.

**Languages.** Nineteen, and every app's chrome carries an English ⇄ Korean
toggle at the end of its ribbon tab row — the shell's is on the tab strip and in
Settings ▸ General. Switching anywhere applies everywhere: the choice is stored
once and a storage event carries it to every open tab and frame.

## Running it

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
… / `SAMUGEN_SHELL_PORT` …), and `strictPort` is set so a busy port fails
loudly instead of moving.

**Chromium 86+**, because the apps open and save real files through the File
System Access API rather than uploading them; there is no server that sees a
document. The AI BFF is the one server piece, it holds only provider
credentials, and in Docker it is deliberately unpublished.

A few capabilities are absent rather than stubbed — PDF export from docs, AI web
search, and the projects/chat-history store, all of which needed a process
outside the page. They are `null` at the platform seam, so a caller has to handle
their absence instead of calling a stub that fails; `docs/web-migration.md` §2.1
explains why, and §8 lists them.

## Engine packages

All pure TypeScript, host-agnostic, unit-tested (except the UI kit):

- `packages/docx-engine` — docx parsing → block tree (with `docxIndex`
  anchors and passthrough), OOXML fragment generation, byte-level paragraph
  patching.
- `packages/pptx-engine` / `packages/pptx-render` — pptx model and rendering.
- `packages/pdf-edit` — PDF editing (pdf-lib) with byte I/O injected, so the
  editing logic never names where the bytes come from.
- `packages/hwpx-convert` — HWPX import/export codecs.
- `packages/file-parse` — text extraction for AI attachments (office formats,
  text formats).
- `packages/platform` — the capability-scoped port interfaces the renderers are
  written against, with `packages/platform-web` as the adapter that backs them.
  A build-time `@host` alias resolves the one host module, and each app's
  platform slot is the only thing renderer code reaches the browser through —
  which is also what lets a test fill it with fakes.
- `packages/agent-core` — the AI agent loop and skill composition shared by
  every app.
- `packages/ai-provider` — provider abstraction and streaming, shared by the
  apps and by the BFF that holds the credentials.
- `packages/ai-search` — web/image search tools (Serper, DuckDuckGo fallback).
- `packages/i18n`, `packages/ui`, `packages/project-store` — shared i18n core,
  React UI kit, and the projects/recent-files store's types (its implementation
  needed a filesystem; the ports that would use it are `null` today).
- `services/ai-bff` — the browser's backend-for-frontend: it holds the provider
  credentials and proxies streaming calls, so no key reaches the page.

## Development

```bash
npm install
npm run fixtures     # generate test .docx fixtures
npm test             # engine + app unit tests, no display needed
npm run typecheck    # tsc --noEmit across every workspace
npm run lint         # eslint

npm run dev          # everything: the four editors, the shell and the BFF
npm run docs:web     # a single app (same pattern works per workspace)

npm run build:shell:web  # the composed bundle the container image serves
npm run test:e2e         # Chromium against that bundle (build it first)
```

The sheets app needs a Rust toolchain for its xlsx engine (`cargo` on PATH), plus
the `wasm32-wasip1` target and a WASI sysroot for the browser module —
`apt-get install clang wasi-libc` is enough on Debian/Ubuntu, and
`npm run wasm:build -w @samugen/sheets` produces it (the web and Docker build
scripts run it for you). Tests that need the module skip loudly when it has not
been built. The crate also builds as a native binary, which is what the engine's
reference tests and benchmarks drive; `npm run native:build -w @samugen/sheets`
compiles it and `npm test` in that workspace does so first.

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

Where the bytes come from and where they go is the one thing the apps never name
directly: it is behind the platform ports, and in a browser it is the File System
Access API throughout. Sheets is the sharpest case — the Rust engine runs as a
WebAssembly module in a Worker, over a JSON protocol, against a WASI filesystem,
and a parity test holds its saves byte-identical to the same crate's native
build. `docs/web-migration.md` is the long-form account of how the seam was
built, and it is what to read before changing it.

## Security

See [SECURITY.md](SECURITY.md) for the security posture (CSP, file access,
external-link gating, where credentials live) and the threat models for
AI-generated content.

## Third-party notices

`npm run licenses` checks every runtime dependency's license; all are
MIT/Apache-2.0/OFL, as are the bundled fonts (Liberation, Carlito, Caladea, Noto
CJK subsets).

## License

SamuGen is licensed under the [Apache License 2.0](LICENSE), with one
exception: the `ee/` directory is reserved for future enterprise modules and
is covered by the [SamuGen Enterprise License](ee/LICENSE).

This is a fork. The GenOffice and Genspark names and logos are trademarks of
Mainfunc, Inc.; the Apache-2.0 license does not grant permission to use them
(see section 6), so they have been removed from this tree and replaced with the
SamuGen name and mark. Anyone forking this in turn should do the same.
