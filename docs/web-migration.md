# Web migration — architecture and handoff

Migrating this Electron monorepo so every app also runs as a pure web app, with
Electron eventually optional. Phases 1–5 are done and committed. Phases 6
(sheets) and 7 (slides) are not started; this document is the handoff for
whoever picks them up.

Everything here was verified against the tree at commit `9be49a8`. Re-verify any
number before relying on it — the point of citing file paths is that you can.

---

## 1. Why this works at all

The load-bearing fact: **91% of the code was already platform-agnostic.**

| Layer                                 | LOC   | Browser-safe?                                                                          |
| ------------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| `apps/*/src/renderer`                 | ~173k | yes — React/TS                                                                         |
| `packages/*/src`                      | ~38k  | mostly — jszip, fast-xml-parser, pdfjs, opentype.js, harfbuzz-wasm all run in browsers |
| `apps/sheets/src/{domain,gateway,ai}` | ~15k  | yes — pure TS, no Electron                                                             |
| `apps/*/src/{main,preload}`           | ~23k  | **no — this is the only part being replaced**                                          |

Electron is a thin shell around the apps, not a foundation threaded through
them. That is why a port layer works and a rewrite was never warranted.

---

## 2. The architecture

### 2.1 The one rule

**No port member is optional.**

The pre-migration approach was hand-written `web-shim.js` files that stubbed
`window.desktop` methods as no-ops. The app booted and every real operation
silently did nothing — `openDocx` returned `null`, `saveDocx` returned
`{ ok: false }`. An unimplemented capability returned `undefined` at runtime
instead of failing to build.

`packages/platform` exists to make that impossible. An app declares what it
needs by _composing_ a narrower platform, and every member of every port it
names is then required:

```ts
export type Platform<K extends PortName = PortName> = Pick<PlatformPorts, K>
export function createPlatformSlot<P>(label: string): PlatformSlot<P>
```

The factory is deliberately not a module-level singleton with a generic getter:
`getPlatform<K>()` could not infer `K`, so it would be an unsound cast at every
call site. Each app fixes `P` once, where its slot is declared.

### 2.2 The two idioms for a genuine capability gap

Never a stub, never an optional method. Use one of:

1. **Split the port finer** when hosts differ structurally. `AiPort` /
   `AiSettingsPort` / `AiChatPort` / `GensparkPort` split this way because
   standalone pdf backs none of the AI channels
   (`apps/pdf/src/main/pdf-main.ts` `startPdfStandalone` registers only
   `registerPdfIpc()`).
2. **A required key typed `X | null`.** Not optional — required, and explicitly
   null. The caller must branch. See `openDocument` in
   `apps/pdf/src/renderer/platform.ts`, and `pdfExport` / `print` / `tabs` /
   `search` / `genspark` in `apps/docs/src/renderer/platform.ts`.

Optional _data fields_ on DTOs are fine and different — `PendingDocument.location`
is optional because a browser genuinely has no path to report. That distinction
is documented next to the field so a reader doesn't "fix" it.

### 2.3 Paths must not cross the seam

Browsers have no file paths. So the seam carries opaque host-issued refs:

- `DocumentRef` — `apps/pdf/src/renderer/platform.ts`. Electron passes its
  absolute path through as the ref, so main and preload needed no changes.
- `AttachmentRef` — `packages/platform/src/ports/attachments.ts`.
  `getPathForFile(file): string` returning `''` on web became
  `refForFile(file): Promise<AttachmentRef | null>`, because `null` is not
  assignable to `AttachmentRef` and a caller must branch.

**Every phase so far has found renderer code parsing a path it had no business
parsing.** Expect more in sheets and slides. Known precedents:

Line numbers below are as of each app's pre-migration commit (`a6ac2d5~1` for
pdf, `67de559~1` for docs), since the fixes moved them.

| Site                               | What it did                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| pdf `App.tsx:653`                  | `filePath.split(/[\\/]/).pop()` for the window title                                              |
| docs `App.tsx:816`                 | same, for the renamed-document title                                                              |
| docs `file-actions.ts:586`, `:622` | same, for the saved filename                                                                      |
| shell `Home.tsx` ×5                | Location column, delete dialog, and a **Copy path** menu item writing a raw path to the clipboard |

The fix is always the same: the host supplies the display string; the renderer
never derives it.

### 2.4 Per-app file layout

Each ported app has:

```
src/renderer/platform.ts          composed slot + app-specific port declarations
src/renderer/platform-electron.ts adapters over the preload bridge
src/renderer/platform-web.ts      adapters over browser APIs
src/renderer/host-electron.ts     reads the preload global — the ONLY module that does
src/renderer/host-web.ts          builds the web platform
vite.shared.ts                    hostAlias('electron' | 'web')
vite.web.config.ts                web build + BFF proxy
```

`main.tsx` imports `@host`, which a Vite alias resolves per config. This is a
**build-time** seam, not a runtime flag: the Electron bundle contains no web
code and the web bundle no preload bridge. Both directions are verified by
grepping built output at the end of every phase.

### 2.5 Shared packages introduced

| Package                           | Purpose                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `@genoffice/platform`             | port interfaces, slot factory, and `file-state.ts` (`isExternallyModified`, shared by both hosts) |
| `@genoffice/platform-electron`    | renderer-side adapters over preload bridges                                                       |
| `@genoffice/platform-web`         | File System Access, IndexedDB handle store, BFF AI port, language, frame protocol                 |
| `@genoffice/pdf-edit`             | pdf-lib editing with byte I/O injected via `PdfBytesIo`                                           |
| `@genoffice/ai-bff` (`services/`) | holds provider credentials server-side; the browser never receives a key                          |

**The injected-I/O pattern** (`packages/pdf-edit/src/io.ts`) is worth reusing:

```ts
export async function savePdf(io: PdfBytesIo, request: PdfEditRequest): Promise<void> {
  const bytes = await applyPdfEdits(await io.read(), request)
  await io.write(bytes)
}
```

In-place Save and Save As become the same call with a different `io`. Electron
supplies an `fs` implementation; the browser supplies a `FileSystemFileHandle`
one. It works when the logic has **one** opaque resource and a tiny port. It
does **not** fit `project-store` — see §6.1.

### 2.6 The AI BFF

Decision: **AI keys live in a BFF, never in the browser.** This is the one place
"webapp" forces a server.

- Routes: `GET /v1/ai/settings`, `POST /v1/ai/stream` (SSE), `.../stream/cancel`,
  `POST /v1/ai/chat`, `GET /health`.
- Reuses `@genoffice/ai-provider` (`streamForProvider`, `chatForProvider`).
- Wire contract lives in `packages/platform-web/src/ai-wire.ts`, imported by both
  sides via the `./wire` subpath so they cannot drift.
- It drops even the `••••1234` hint that `toPublicAiSettings` normally keeps, so
  "no credential reaches the browser" is absolute and testable.
  `services/ai-bff/tests/no-leak.test.ts` generates **every substring of the
  credential of length ≥ 4** and asserts none appears in any response body.
- A browser-supplied `settings` field on a stream request is **dropped**, not
  honoured — otherwise a page could aim the server's credentials at an endpoint
  of its choosing.
- `connect-src 'self'` in every app's CSP means the BFF must be same-origin.
  Dev servers proxy it; **production needs the equivalent rule in whatever fronts
  the app, or AI calls are blocked.**

---

## 3. Completed phases

| Commit    | Phase | Result                                                                        |
| --------- | ----- | ----------------------------------------------------------------------------- |
| `a6ac2d5` | 1–3   | platform seam, `pdf-edit`, `platform-web`, BFF; **pdf runs in a browser**     |
| `67de559` | 4a/4b | `AttachmentsPort` ref-based; **docs runs in a browser**                       |
| `3913e8f` | 4c/5a | docs browser printing; shell platform seam; per-app IndexedDB stores          |
| `9be49a8` | 5b    | **web shell** — routing + tab bar hosting docs and pdf in same-origin iframes |

Test counts at `9be49a8`: docs 701, pdf 152, shell 144, platform-web 98,
ai-bff 52, platform 11, platform-electron 13, pdf-edit 21.

Run the web stack with `npm run shell:web` (shell + both editors + BFF).

### 3.1 The web shell

Same-origin iframes, one per tab, lazily created, hidden rather than unmounted
when backgrounded (unmounting would discard unsaved state). Served under
sub-paths of the shell origin (`/app/docs`, `/app/pdf`) with each editor's Vite
`base` set to match.

Sub-paths are **load-bearing**: `/v1/ai` is root-relative and the BFF sends no
CORS headers, so cross-origin frames would break every AI call, and same-origin
is what lets the tab strip read `iframe.contentDocument.title`.

Cross-frame coordination is a versioned protocol in
`packages/platform-web/src/frame-wire.ts` (`beforeunload` does not fire per
iframe). Inbound messages are validated on origin, protocol tag, and every
field; the literal `'null'` opaque origin is rejected explicitly, including when
the page itself is opaque and a bare equality check would pass. The shell also
binds `event.source` to the window registered for that frame id
(`frame-host.ts:117`), so one frame cannot answer a close check on another tab's
behalf.

**A combined single-page bundle was rejected**, and the reasons apply to sheets
and slides too. It would have to resolve: `#root` colliding in both apps'
`main.tsx`; unprefixed `:root` CSS variables declared with _different values_ in
both apps; divergent CSPs (pdf needs `wasm-unsafe-eval`, docs does not); four
document-level singletons both apps write (`document.title`,
`documentElement.lang`, `window.print()`, `beforeunload`); and ~20 global
listeners landing on one `window`.

**File System Access requires transient user activation, which is per-`window`.**
A Save click must be handled _inside_ the frame. The shell owns the tab strip
only and must never proxy a save/open click across the frame boundary. This is
why "Open Local File" from Home does not exist on web.

---

## 4. Phase 6 — sheets

### 4.1 Shape

| Metric                                   | Value                              |
| ---------------------------------------- | ---------------------------------- |
| renderer                                 | ~56k LOC                           |
| `src/{domain,gateway,ai}`                | ~15k LOC, **pure TS, no Electron** |
| `src/main`                               | ~5.3k LOC (`sheets-main.ts` 2836)  |
| `src/preload/index.ts`                   | **2125 lines**                     |
| `ipcMain` handlers                       | 35                                 |
| renderer files touching `window.desktop` | 12                                 |

The gateway and domain layers are already browser-safe and are imported by the
renderer today (`renderer/App.tsx`, `workbook-ops.ts`, `univer-sync.ts`,
`view-transform.ts`, …). That is a large head start.

### 4.2 The blocker: the Rust sidecar

`apps/sheets/native/xlsx-engine` is **~7k lines of Rust** built as a binary
(`name = "xlsx-sidecar"` in `Cargo.toml`) and spawned as a **child process**
over a line-delimited JSON stdio protocol
(`apps/sheets/src/main/xlsx-sidecar-client.ts`, 241 lines).

A browser cannot spawn it. Two options:

**(a) Compile to WASM with wasm-bindgen — recommended.** There is currently
**no `[lib]` / `crate-type` and no wasm-bindgen dependency** in `Cargo.toml`, so
this is real work, not a flag. But the protocol boundary already exists and is
narrow — 11 commands:

```
open  close  read_range  read_entries  read_formula_cells  read_media
scan_entries  recalc_cells  archive_manifest  save_archive  convert_workbook
```

`XlsxSidecarClient` isolates all of them behind a request/response interface, so
you swap the transport, not the callers. Watch for: `REQUEST_TIMEOUT_MS` 30s and
`ARCHIVE_TIMEOUT_MS` 180s exist because whole workbooks stream through — a WASM
build blocks the main thread instead, so it likely belongs in a Web Worker.

**(b) Keep it as a service** behind the BFF. Avoids the WASM port but makes the
web build depend on a server for core spreadsheet operations, and ships user
documents to it. Not recommended.

### 4.3 Suggested sub-phases

1. **6a — seam only.** `platform.ts` / `host-electron.ts`, migrate the 12
   renderer files, Electron unchanged. Mirror Phase 4a exactly.
   Note `notifyPendingEdits(count)` is sheets' dirty signal, where pdf uses
   `setDirty(boolean)` — model it honestly rather than coercing to a boolean.
2. **6b — WASM build** of the Rust crate, with `XlsxSidecarClient`'s interface
   reimplemented over it. Independently testable against the same 11 commands.
3. **6c — web host**: FSA for xlsx open/save, attachments, AI via BFF, and the
   sheets frame added to the web shell.

---

## 5. Phase 7 — slides

The hardest phase. Do not attempt it in one pass.

### 5.1 Shape

| Metric                           | Value         |
| -------------------------------- | ------------- |
| renderer                         | ~53k LOC      |
| `src/main`                       | **~8.4k LOC** |
| `ipcMain` handlers               | **147**       |
| preload bindings                 | 163           |
| renderer files touching the host | 24            |

Main-process files: `slides-main.ts` 3994, `i18n-main.ts` 2119, `fonts.ts` 581,
`ai-ipc.ts` 442, `session-state.ts` 296, `attachments-ipc.ts` 229,
`shaped-metrics.ts` 227, `edit-text.ts` 178, `presenter-show.ts` 159.

### 5.2 Why it is harder than docs

**`pptx-engine` runs in the main process, not the renderer.** Four main-process
files import it (`slides-main.ts`, `ai-ipc.ts`, `edit-text.ts`,
`session-state.ts`); the renderer imports it only for `smartart-layout` types,
via deep relative paths that bypass the package's exports map:

```ts
// apps/slides/src/renderer/insert-presets.ts:6
import type { SmartArtLayout } from '../../../../packages/pptx-engine/src/smartart-layout'
```

docs was tractable precisely because `docx-engine` was **already** renderer-side.
Slides is the opposite: the parse/edit/save engine, session state and text
editing all have to move down into shared packages before a web host is possible.
That relocation — not the IPC count — is the real work.

**The engine itself is now browser-safe** (done, see the commit that added
`packages/pptx-engine/src/bytes.ts`). It was not, and the reasons were invisible to
the type system:

- 66 `Buffer` uses, almost all `Buffer.from(xml, 'utf8')` where an XML part is
  written back into the archive. `Buffer` is a global that resolves in Node, so a
  bundler emits the reference happily and it throws only when a user opens a deck.
- `node:crypto` for the archive hash (`createHash`) and section GUIDs
  (`randomUUID`), and `node:zlib` (`deflateSync`) for the poster PNG.
- `node:fs` / `node:stream` in `savePptxToFile`, behind `await import()` — which
  reads as lazy but is not, because a bundler still resolves the specifier while
  building. It now lives at the `@genoffice/pptx-engine/node` subpath, the only
  module in the package allowed to name a Node builtin.

Replaced with `TextEncoder` / `TextDecoder` / `crypto.subtle` / `atob` — one
implementation for both hosts, no polyfill and no fallback. Two things worth
knowing before touching that file:

- `utf8Bytes` copies what `TextEncoder` returns, and the copy is load-bearing.
  Under jsdom the encoder comes from a different realm than the page's
  `Uint8Array`, so its output fails `instanceof Uint8Array` — which is exactly how
  JSZip identifies a part body. Removing the copy fails two slides tests with
  "Can't read the data of '[Content_Types].xml'".
- The poster PNG writes _stored_ (uncompressed) deflate blocks. A browser's only
  built-in deflate is `CompressionStream`, which is async, and the only thing that
  reaches this path is a 16×9 placeholder — 441 raw bytes. Real image data would
  justify the async cost; a placeholder does not.

`tests/browser-safety.test.ts` is the guard: every `node:*` module resolves to a
throwing proxy and `Buffer` is deleted from `globalThis`, then a deck is created,
opened, edited and saved. Build-time was verified separately by bundling
`src/index.ts` with esbuild at `platform: 'browser'` — 75 modules, zero Node
builtins (`pptx-render` likewise: 15 modules, zero).

### 5.3 Fonts

`apps/slides/src/main/fonts.ts` scans system font directories
(`/System/Library/Fonts`, `C:\Windows\Fonts`, `/usr/share/fonts`, …) and parses
real font files with opentype.js, including splitting `.ttc` collections by hand
because opentype.js cannot read them. Text layout fidelity depends on it.

- **Browser answer: `queryLocalFonts()`** (Chromium 103+, permission-gated).
  It returns real font blobs you can feed to the _unchanged_ opentype.js code.
- **`shaped-metrics.ts` is already harfbuzz-WASM** (`harfbuzzjs`) for
  Arabic/Hebrew/Thai/Devanagari — it ports as-is. Note it currently deep-imports
  `../../../../node_modules/harfbuzzjs/dist/harfbuzz.js` and uses a `?asset`
  import for the wasm, both of which need revisiting for a web build.
- Fallback if `queryLocalFonts` is unavailable or denied: bundle metrics for the
  common OOXML fonts and keep the existing `HeuristicMetrics` path.

### 5.4 Relocate before you write the seam

The sub-phases below say "7a — seam only, mirror 4a". **Do not.** That order was
inferred from docs, where it was right; for slides it is backwards, and the handler
list says why. Of the 147 `ipcMain` channels, about 120 are document operations —
`add-*`, `edit-*`, `set-*`, `get-*`, `delete-*`, `undo`/`redo`, `table-*`,
`master-*`, `find-replace`, `history-batch-*` — and every one of them is a
mutation of the `OpenedPptx` that `session-state.ts` holds, followed by a rebuilt
`RenderSlide`. On a host where the engine runs in the page, those are not host
calls at all: they are local function calls, and a port member for each would be
120 members written in 7a and deleted in 7b.

What is genuinely a host service is the other ~25: `open`, `open-path`, `save`,
`save-as`, `recent`, `consume-pending-open`, `export-pdf`, `pick-export-dir`,
`pick-export-pdf-path`, `files-pick`, `files-add`, `files-read-image`,
`native-clipboard`, `clipboard-external`, `media-data`, `is-dirty`,
`close-save-result`, `autosave-pref`, the five `presenter-*` and two `audience-*`
channels, `app:get-language` and the seven `ai:*`. That is the size of docs' seam,
not five times it.

So: relocate the session and the document operations out of `registerSlidesIpc`
first (Electron's handlers become one-line delegations, behaviour identical), and
the seam that follows is small. The relocation is the same shape sheets already
has in `src/{domain,gateway,ai}` — pure TS the renderer imports directly — which is
the precedent to copy rather than inventing a new arrangement.

### 5.5 Suggested sub-phases

0. **7-0 — engine browser-safety. Done.** `Buffer` and every Node builtin are out of
   `pptx-engine`; the `node:fs` streaming save moved to the `./node` subpath, guarded by
   `tests/browser-safety.test.ts`. §5.2 has the details.
1. **7a — relocate the session and the operations. Done.** `src/domain/session.ts` holds
   the session, history and RenderSlide rebuilds, with font metrics and the TIFF decoder
   injected through `setSlideRenderEnv`. `src/domain/ops.ts` holds all 84 relocatable
   document operations, moved verbatim — a script diffed every body against the
   pre-move commit, and the only intentional change is an injected translator argument.
   `edit-text.ts` moved too. Both files bundle at esbuild `platform: 'browser'` with zero
   Node builtins and no electron.
2. **7b — the seam. Done.** `src/renderer/platform.ts`, thirteen ports, every one a
   `Pick<SlidesApi, …>` so nothing is retyped. 241 call sites moved off
   `window.slidesApi`; `host-electron.ts` is the only module that reads a global. Seven
   ports are `X | null` (presenter, pdfExport, clipboard, genspark, search, cloud, menu)
   and their thirty call sites branch. `@host` is wired as in docs and pdf.
3. **7c — fonts.** `queryLocalFonts()` + harfbuzz-wasm in the browser. Note that
   `shaped-metrics.ts` cannot even be loaded outside Electron today — its `?asset` wasm
   import resolves to a path Node tries to import as a module — so
   `tests/render-env-wiring.test.ts` stubs it. That import is the first thing to fix.
4. **7d — web host** and the slides frame in the shell. Read §5.5 first.

### 5.5 7d: what is done, and what is left

**Done.** The `doc` port's split was corrected first, as this section used to warn it had to
be: all 84 of its members now map one-to-one onto an operation in `src/domain/ops.ts` (78 by
name, 6 by a spelling difference the adapters absorb), and the ~20 host-coupled members that
the name heuristic had put there moved to the ports they belong to — the paste bookkeeping to
a new required `deckClipboard`, printing to a new required `print`, AI settings and streaming
to `ai`, `gskStatus` to `genspark`, the presenter callbacks to `presenter`, `htmlToPptx` to
`cloud`, and the style templates to a new nullable `styleTemplates`. Fifteen ports: eight
required, seven `X | null`.

Nine more operations were relocated to make that honest: `setTextAnchor` (pure, missed by the
first inventory, whose regex needed the channel on the same line as `ipcMain.handle(`); the
five clipboard operations, which now take a `DeckClipboardStore` the host owns; `editChart`,
which takes its confirmation as a parameter; and `setImageFillBytes` / `addModel3dBytes`,
split from their file dialogs so the second half is shared.

`platform-web.ts` backs two ports so far — `doc` (all 84 members, calling the operations
directly in the page) and `deckClipboard` (page-local, so it crosses slides within one deck
and no further, which is narrower than the desktop's cross-window clipboard and says so).
Both are covered by `tests/platform-web-doc.test.ts`, which opens a real deck and edits it
with nothing mocked.

**Left.** Five ports, then the host:

- `file` (12 members) over the File System Access API: open, reopen by ref, new blank, save,
  Save As, and the four picker-driven inserts, which now have operations waiting for their
  bytes. `getRecentFiles` returns paths today, so on web it should report an empty list
  rather than hand the renderer a ref to display — the same call pdf made.
- `window` (the close guard over `beforeunload`, `isDirty`), `language` (the shared web
  language port), `print` (the same HTML the desktop renders in a hidden window, printed from
  a frame), and `ai` over the BFF.
- `attachments`, which is still path-based here while docs' became ref-based in Phase 4a.
  §6.3 is that collapse and it has to happen before a browser can back this port.
  **Done:** slides' `attachments` is now the shared `AttachmentsPort`. The renderer holds an
  opaque `AttachmentRef`; the chip's tooltip reads the optional `location` instead of a path;
  the unread-attachment gate that fed `generate_deck` keys on refs. `DesktopFilesApi` and the
  whole main-process side are untouched, because the ref↔path mapping happens in the adapter
  — which moved to `packages/platform-electron/src/attachments.ts`, since docs, slides and
  sheets all expose the same six path-based methods and there is no reason for three copies of
  one mapping.
- Then `createWebSlidesPlatform`, `host-web.ts`, `vite.web.config.ts`, and an `index.html`
  with a CSP. **Done.** `npm run slides:web` serves the editor at :5185 with the BFF beside
  it, and `npm run build:slides:web` writes `dist/web`. The existing `index.html` needed no
  change — both hosts share it, and its CSP was already `connect-src 'self'`.

  Three things the host had to decide, each recorded where it is made rather than here:

  - **Fonts.** `HeuristicMetrics`, the provider pptx-render falls back to when a font file
    cannot be read — deterministic, but its advances are estimates, so a tightly-fitted text
    box can wrap a word earlier or later than the desktop. `queryLocalFonts()` is the exact
    answer and is 7c; `host-web.ts` is the one line that changes.
  - **TIFF.** `decodeTiff: null`. Chromium decodes none, and the interface's `null` is how a
    host says so: those pictures render blank rather than wrongly, and their bytes survive a
    save untouched.
  - **Printing.** The same HTML the desktop renders in a hidden window, printed from a hidden
    same-origin iframe, because the page itself is the editor.

  Verified in Chromium (Playwright): the app boots to a blank deck, the ribbon's New Slide
  goes through the in-page operations and the thumbnail pane follows, and the bundle contains
  no Node builtin, no `electron`, and no `window.slidesApi`.

### 5.6 The original notes on what 7d had to sort out

The seam's `doc` port was split by a heuristic over member names, and it is slightly too
generous: 76 of its 104 members are backed by an op of the same name, six more differ
only in spelling (`addSmartArt`/`addSmartart`, `beginHistoryBatch`/`historyBatchBegin`,
`endHistoryBatch`/`historyBatchEnd`, `getMediaData`/`mediaData`,
`setSlideHidden`/`setHidden`, `getChartColorSchemes`/`chartColorSchemes`), and the
remaining ~20 are host-coupled and belong in other ports before a web host can claim
`doc` honestly:

- **clipboard/paste bookkeeping** — `copySlide`, `pasteSlide`, `repasteSlide`,
  `copyElements`, `pasteElements`. These keep per-renderer state (`lastSlidePaste`,
  `clipboards`) and stayed in slides-main for that reason; on web they become
  page-local, which is simpler, not harder.
- **dialog-backed** — `editChart` (a confirmation box), `insertMedia`, `getRecentFiles`.
- **AI settings and streaming** — `getAiSettings`, `setAiSettings`, `onAiStream`,
  `generateImage`, `analyzeMedia`, `gskStatus`. These belong to the `ai` and `genspark`
  ports; `aiSettings` in particular is read-only in a browser (§6.2).
- **presenter callbacks** — `onShowSync`, `onShowInk`, which belong to `presenter`.
- **still to place** — `htmlToPptx` and `printSlides` (the browser prints, as docs does),
  `listStyleTemplates`/`loadStyleTemplate`, `editImageFill`, `setTextAnchor`.

Re-splitting those is the first task of 7d, not an afterthought: claiming them on the
`doc` port would make a web host either lie or stub, which is the failure this whole
arrangement exists to prevent.

---

## 6. Cross-cutting decisions still open

### 6.1 `@genoffice/project-store`

716 sync lines, ~30 filesystem call sites across 15 methods, and it _constructs
its own paths_. It does **not** fit the `PdfBytesIo` pattern — that worked
because pdf-edit had one opaque resource and a 2-method port.

Six things resist a port:

1. Everything is synchronous, and callers depend on it (`ipcMain.handle` returns
   store values directly). Any browser backend is async. Silver lining:
   `ProjectApi` in `src/ipc.ts` is already all-`Promise`.
2. `fileMap` and `chatIdByPath` key on **absolute user-document paths**. A
   browser has none. This is upstream of the I/O seam.
3. Chat ids come from a **directory scan** (`readdirSync` + strip `.jsonl`), not
   a registry.
4. `statSync().mtime` is load-bearing data — `ChatMeta.updatedAt` and
   `ProjectSummary.lastActiveAt` are never written by the store.
5. `existsSync` means two different things: "does this store file exist"
   (portable) and, at one site, "does the _user's document_ still exist"
   (not answerable by a storage backend).
6. No locking, with multiple writers today — shell/docs/sheets/slides each
   construct their own `ProjectStore` over the same `userData`, including a fresh
   instance per call in `apps/shell/src/main/index.ts`.

**Recommendation:** extract the already-pure half (chat-id derivation, JSONL
parse/validate/sort, timeline assembly, index mutation) into a `logic.ts` with
plain data in and out, leaving `store.ts` as the sync-fs shell. Then build the
web port against the **six** methods the Home page actually needs — `list`,
`listFiles`, `create`, `rename`, `delete`, `moveFile` — keyed by ref, not path.
The closest existing analogue is `WebDocumentStore`, a stateful ref→handle
registry, not `PdfBytesIo`.

This is why Home in the web shell is launcher-only and recents are empty.

### 6.2 BFF authentication and tenancy

The BFF is **read-only by construction and single-tenant**: it reads env vars
once at boot into a closure. There is no settings-mutation route, no keychain, no
auth, no session, no user concept — mitigated only by the loopback default bind.

Consequences:

- AI provider settings are **read-only in the browser**. Editing is not a UI
  task; its first requirement is authentication.
- `active` is a global map keyed by a **client-supplied** `requestId`, so any
  caller who knows an id can cancel someone else's run.

Before this is exposed on any routable interface, it needs auth, a tenancy
decision, and a persistent credential store with a redaction contract for the
inbound direction.

### 6.3 Attachment port duplication

`apps/sheets/src/shared/desktop-api.ts` and `apps/slides/src/shared/ipc.ts` each
declare their own path-based attachment methods locally rather than importing
`AttachmentsPort`. That is why the ref-based refactor in Phase 4 did not break
them. Phases 6 and 7 should collapse that duplication onto the shared port.

**slides: done (Phase 7d).** Its renderer now holds the shared ref-based port; the
local declarations in `shared/ipc.ts` stayed, because they describe the _preload
bridge_, which is legitimately path-based — the main process addresses attachments
by path and always will. The mapping lives once, in
`packages/platform-electron/src/attachments.ts`, and is the only code allowed to
read a ref as a path. **sheets is still to do** and is the last copy; the same
adapter already fits its bridge unchanged, so that collapse is renderer-side work
only (`App.tsx`, `ExcelShell.tsx`, `ai/AiChatPanel.tsx`, `ai/files-skill.ts`).

### 6.4 Stale `Lang` unions

`Lang` in `@genoffice/i18n` has **19** values. `apps/docs/src/shared/ipc.ts:136`,
`apps/sheets/src/shared/desktop-api.ts:1858` and
`apps/slides/src/shared/ipc.ts:982` each inline a stale **11**-value copy,
missing `pt`, `it`, `pl`, `nl`, `ms`, `he`, `hi`, `zh-TW`. The shell can persist
those values. This is a live bug independent of the migration.

### 6.5 Standalone pdf has no AI

`startPdfStandalone()` (`apps/pdf/src/main/pdf-main.ts`) calls only
`registerPdfIpc()`, never `registerAiIpc`. So `npm run dev -w @genoffice/pdf`
has a non-functional AI panel — every action rejects with an unhandled-channel
error. It works only as a shell tab. Pre-existing; fix by registering the AI IPC
there or hiding the panel in standalone mode.

---

## 7. Working checklist

Learned the hard way; each item cost real time.

- **Add every new package to the root `package.json` `typecheck` _and_ `test`
  chains in the same edit.** `platform-web` was omitted once and shipped with a
  typecheck error that "full workspace typecheck passes" did not catch.
- **Web build `outDir` must never be under `apps/*/out/`.**
  `apps/shell/electron-builder.cjs` has `files: ['out/**']` and ships
  `from: '../<app>/out'` as extraResources — a web bundle there gets packaged
  into every desktop installer. 6.5 MB shipped this way once. Use `dist/web`.
- **New user-facing strings must exist in all 19 languages.** `createI18n` has
  **no fallback** — a missing key renders `undefined` at runtime rather than
  failing the build. `apps/docs/tests/i18n-strings.test.ts` asserts key and
  placeholder parity; copy that pattern.
- **Verify bundle separation by grepping built output**, both directions, at the
  end of every phase.
- **Keep each phase small enough that the tree still compiles if it dies.**
  Three agents were killed mid-phase by infrastructure limits; recovery was cheap
  every time only because the tree was never left broken.
- **Comments and in-file text in English** (repo ground rule, `CLAUDE.md`).
- Electron behaviour must stay identical in every phase that is not explicitly
  changing it. `git diff apps/<app>/src/main apps/<app>/src/preload` should be
  empty for seam phases.

---

## 8. Known non-functional in the browser today

Not bugs — capabilities deliberately represented as absent rather than stubbed.

**docs:** PDF export (print via `window.print()` only, by decision); AI web and
image search (needs BFF routes); Genspark sign-in; crash-recovery copies
(`DocsFilePort.crashRecovery` is false, so the renderer's 30s tick does not run);
silent first save of a never-saved document; `.pdf` / `.ppt` / `.xls` attachments
(rejected at add time with a reason); attachment refs do not survive a reload;
attachment rejection messages are English-only.

**No automatic save may open a dialog.** Learned from a bug, so it is written down
here rather than left to each call site. `saveNew` and `save` both take the
caller's intent, and on web an automatic save refuses (`needs-user-gesture`,
`needs-permission`) rather than opening a picker or a permission prompt:

- The renderer's recovery tick reached `saveNew` every 30 seconds for a
  never-saved document. `saveNew` gated on `navigator.userActivation.isActive`,
  which stays true for seconds after every keystroke — so a document being typed
  into held activation continuously and the Save As dialog opened on a timer.
  Activation says a dialog _may_ open, never that anyone wanted one.
- An autosave of a document that _does_ have a handle writes through
  `WebDocumentStore.write(..., { prompt: false })`. A handle from the open dialog
  carries read permission only, and one restored from IndexedDB carries none, so
  requesting the write grant from a timer would either raise a permission dialog
  unbidden or be rejected for want of activation and read as a failed save.

Getting a document out of a browser that has no handle for it is
`DocsPlatform.download` (File → Download), which copies the bytes and adopts
nothing: no ref, no recent entry, and the document stays as dirty as it was.

**pdf:** Save As (shell-menu-driven); no recent-files UI, though handles _are_
persisted.

**shell:** Home is launcher-only — recents and starred always empty (§6.1);
"Open Local File" from Home absent (user-activation constraint, §3.1); projects;
updates; account sign-in (shells out to the `gsk` CLI); native tab menus; sheets
and slides cards (no web build yet). A reload reopens an empty tab of the right
kind, not the document.

**Everywhere:** Chromium only, by decision — File System Access and
`queryLocalFonts` have no Safari/Firefox equivalent. A browser without them gets
a loud failure, not a silent fallback.

**Not click-tested.** Phase 5b's shell, close-guard handshake, tab strip and
routing are covered by unit tests against injected fakes. Dev servers, the proxy,
module resolution and both builds were verified; a real browser session was not.
Do a manual pass before trusting it.
