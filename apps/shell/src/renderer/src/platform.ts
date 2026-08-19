/**
 * The shell's platform slot: the one place the renderer names the host
 * capabilities it needs, and the only thing renderer code is allowed to reach
 * the host through. After this phase the preload globals are read in exactly one
 * place — host-electron.ts, the module the two renderer entry points bootstrap
 * from — and nowhere else in the renderer. Same arrangement as apps/pdf and
 * apps/docs.
 *
 * Two slots, not one, because the shell ships two documents with two different
 * preloads: `index.html` (the tab strip + Home, backed by `window.aiOffice`,
 * `window.aiOfficeTabs`, `window.aiOfficeProject`, `window.aiOfficeAiSettings`)
 * and `update.html` (the auto-update dialog, backed by `window.aiOfficeUpdate`
 * and nothing else). Neither document can honour the other's ports, so folding
 * them into one composition would force a host to claim capabilities it has no
 * channel for — the exact failure this seam exists to prevent. See
 * `UpdateWindowPlatform` at the bottom.
 *
 * Almost nothing here comes from @genoffice/platform's shared catalogue, and
 * that is the honest result rather than an oversight: the shell is the *host
 * surface* the editors are hosted in, so its capabilities are the ones the
 * shared ports are defined against, not instances of them. Port by port:
 *
 *   - `language` — the shared `LanguagePort` itself, the one port here that is.
 *     The shell is still where the language is *persisted*, but no longer the
 *     only place it is chosen: every editor's chrome carries the same toggle,
 *     so the shell subscribes to `onLanguageChanged` on the same channel its
 *     editors do.
 *   - `project` — deliberately not the shared `ProjectPort`. That port aliases
 *     @genoffice/project-store's `ProjectApi`; the shell's own surface is the
 *     flatter, positional-argument UI adapter that ports/project.ts already
 *     names as a separate thing. Wiring the canonical one here would mean
 *     reshaping the main-process IPC, which this phase must not touch.
 *   - `window` — deliberately not the shared `WindowPort`. Its `TabInfo` is one
 *     app's own tabs; the shell's `TabSummary` is the cross-app strip (kind,
 *     closable, active) that positions every editor's WebContentsView.
 *     ports/window.ts records this divergence already.
 *   - `ai`, `aiSettings` (the shared one), `aiChat`, `genspark`, `search`,
 *     `attachments` — no shell renderer call site. The shell never streams,
 *     never searches and has no chat surface; its AI screen edits provider
 *     configuration through its own IPC (see `ShellAiSettingsPort`).
 *
 * Bridge members with no renderer call site are left out, as elsewhere in this
 * seam:
 *   - `HomeApi.openTrash` — forwarded by the preload, never called by any
 *     renderer file. The trash is reachable from the OS.
 *   - `ProjectHomeApi.getTimeline` — same: forwarded, never called. (The
 *     `timelineCountKey` helper in counts.ts is likewise unused by any view; it
 *     is kept because a test asserts on it.)
 *   - `HomeApi.renameFile`'s new path — the bridge reports it, but every caller
 *     reloads the list instead of reading it, so `RenameFileResult` does not
 *     carry it (and could not carry it as a path anyway; see `FileRef`).
 *
 * Paths never cross this seam. The Home page is the shell's file browser and was
 * the densest concentration of path-as-structure in the tree: it derived the
 * Location column by splitting on separators, derived the delete dialog's file
 * names the same way, and relayed `string[]` paths from the project store into
 * `statPaths`. Every one of those is now a host-issued `FileRef` plus
 * host-supplied display fields, on the `DocumentRef` precedent from apps/pdf.
 */
import { createPlatformSlot, type LanguagePort } from '@genoffice/platform'
import type { AiSettingsApi } from '../../shared/ai-settings-api'
import type {
  AccountLoginEvent,
  AccountStatus,
  ProjectSummaryEntry,
  RecentQuery,
} from '../../shared/home-api'
import type { TabsApi, TabSummary } from '../../shared/tabs-api'
import type { UpdateWindowApi } from '../../shared/update-api'

/**
 * Opaque handle to one file the host knows about, issued by the host.
 *
 * The renderer stores it, compares it for identity (list keys, the selection
 * set, "which row is being renamed") and hands it back — nothing more. It must
 * never be parsed, split, displayed or built: Electron's happens to be an
 * absolute path, a browser host's would be a key into its own handle store, and
 * only the host that issued a ref may interpret it. Everything the UI shows
 * comes from the sibling display fields on `FileEntry`.
 */
export type FileRef = string

/** One row of the Home file lists: the handle, plus everything the row renders. */
export interface FileEntry {
  ref: FileRef
  /** Display name including the extension, e.g. `report.docx`. */
  name: string
  /** Lowercased extension without the dot; drives the file-type badge and the type filter. */
  ext: string
  /** Last-modified time, ms since epoch. */
  mtimeMs: number
  sizeBytes: number
  starred: boolean
  /**
   * Display name of the containing folder — the Location column — or undefined
   * when the host has none.
   *
   * Host-supplied because the renderer used to compute it by splitting the path
   * on separators (`parentDir` in Home.tsx), which is the same defect class as
   * pdf's old basename-from-path derivation: correct only while a ref happens to
   * be a path. It is deliberately *not* derivable from `location` either — doing
   * that in the renderer would be the identical leak wearing a different name.
   */
  folder?: string
  /**
   * Full human-readable location, for display only ("Copy path"), or undefined
   * when the host has none. Never parsed, never passed back to the host — use
   * `ref` for that. Electron supplies the absolute path; a browser host supplies
   * nothing, since a picked file exposes no location.
   *
   * Optional on purpose, and not a breach of the seam's no-optional-members
   * rule: that rule bans optional *methods*, which let a host claim a capability
   * and silently no-op it. This is a *data* field describing something a host
   * genuinely may not possess, and every consumer has to handle its absence
   * explicitly. Same reasoning as `PendingDocument.location` in apps/pdf.
   */
  location?: string
}

/** One page of a Home list, with the totals the sidebar counters and the loader need. */
export interface FilePage {
  entries: FileEntry[]
  /** Total matching the query's `ext` filter. */
  total: number
  /** Total ignoring the `ext` filter. */
  totalAll: number
}

/**
 * Outcome of renaming a file.
 *
 * No new ref: the host has renamed the file underneath its own handle and the
 * caller reloads the list, which is also the only thing the current UI does with
 * the result. Surfacing a path here would put one back in the renderer.
 */
export interface RenameFileResult {
  ok: boolean
  error?: string
}

/**
 * The Home file lists and the operations on their rows.
 *
 * `RecentQuery` (offset / limit / ext) is reused from the IPC contract
 * unchanged: it is pure paging and carries no path.
 */
export interface ShellFilesPort {
  /** Recently opened files across every document type, newest first. */
  recents(query?: RecentQuery): Promise<FilePage>
  /** Starred files, independent of the recent list, newest first. */
  starred(query?: RecentQuery): Promise<FilePage>
  /**
   * Metadata for a specific set of refs (the project files view); refs the host
   * can no longer resolve are dropped rather than reported.
   */
  statFiles(refs: FileRef[]): Promise<FileEntry[]>
  toggleStar(ref: FileRef): Promise<void>
  /** Drop entries from the recent list; the files themselves are untouched. */
  removeRecent(refs: FileRef[]): Promise<void>
  /** Rename in place. `newName` includes the extension. */
  rename(ref: FileRef, newName: string): Promise<RenameFileResult>
  /** Copy the file beside itself under a localized "copy" suffix, and record it as recent. */
  duplicate(ref: FileRef): Promise<void>
  /** Move files to the host's trash and drop them from the recent list. */
  deleteFiles(refs: FileRef[]): Promise<void>
  /**
   * Show the file in the host's file manager, or `null` on a host that has none.
   *
   * Null-valued rather than an optional method, for the reason
   * `PdfFilePort.openDocument` is: an optional method would let a host claim the
   * capability and silently no-op it, so the row menu would offer "Reveal in
   * folder" and nothing would happen. A *required key* holding either a function
   * or `null` cannot be faked — the renderer has to test it before it can call
   * it, so the menu item exists exactly when revealing works.
   */
  reveal: ((ref: FileRef) => Promise<void>) | null
}

/** Where a newly created document should land. */
export interface NewDocumentOptions {
  /** Add the new file to this project; omitted when no project is selected. */
  projectId?: string
}

/**
 * Opening editor surfaces from Home.
 *
 * Separate from `ShellFilesPort` because it is a different kind of capability:
 * the file port reads and edits the host's file bookkeeping, while every member
 * here *navigates* — in Electron by asking the main process for a
 * WebContentsView tab, in a browser by routing to an in-page frame. A host could
 * plausibly back one and not the other.
 *
 * Only the two members every host can back live here; the three that a browser
 * cannot are their own ports below. `open` stays because it takes a `FileRef`,
 * so on a host that issues no refs it is unreachable by construction rather than
 * unimplementable — see `ShellFilesPort` on the web host.
 */
export interface ShellLauncherPort {
  /** Open an existing file, routed to the right editor by its type. */
  open(ref: FileRef): Promise<void>
  newDoc(options?: NewDocumentOptions): Promise<void>
}

/**
 * Creating spreadsheet documents.
 *
 * Split out of `ShellLauncherPort` because apps/sheets has no browser build, so there is no
 * surface for a web shell to route to. `X | null` rather than an optional method, for the
 * usual reason — Home's quick card exists exactly when the document it promises can be
 * created, instead of being present and inert.
 *
 * One port per editor rather than one "office" port for both: they were a pair while both
 * were desktop-only, and stopped being one the moment slides gained a browser build. A
 * capability that two hosts disagree about is a port; two capabilities that disagree
 * separately are two ports.
 */
export interface ShellSheetsLauncherPort {
  newSheet(options?: NewDocumentOptions): Promise<void>
}

/** Creating presentations. Backed by both hosts: apps/slides has an Electron and a web build. */
export interface ShellSlidesLauncherPort {
  newSlide(options?: NewDocumentOptions): Promise<void>
}

/**
 * The shell's own "open a file" picker: pick anywhere on the machine, then route
 * the result to the editor that handles its type.
 *
 * Null on the web host, and this is the sharpest capability difference in the
 * whole seam. A browser file picker requires transient user activation, and
 * activation is per-`window`: the click that would open this picker happens in
 * the shell's document, so the shell could indeed *show* the dialog — but the
 * handle it obtains then has to reach the editor's frame and be adopted there,
 * and every subsequent save in that frame is a separate grant. The shell claims
 * nothing it cannot finish, so opening a document on the web starts inside the
 * editor frame, where the click, the picker and the file handle are all in one
 * window. See `ShellPdfLauncherPort` for how a frame is reached in the first
 * place.
 */
export interface ShellBrowsePort {
  /** Host file picker accepting every supported type, then routes to the editor. */
  browse(): Promise<void>
}

/**
 * Opening a pdf surface with no document in it.
 *
 * The mirror image of `ShellBrowsePort`, and null on *Electron* rather than on
 * the web — the only port in this seam that way round. Electron's pdf tab is
 * created around a path (`openPdfTab(openPath: string)`), so there is no such
 * thing as an empty one; the web shell's is a frame that renders pdf's own empty
 * state, whose Open button runs inside that frame with its own user activation.
 * That is the entry point that makes pdf reachable at all in a browser, so it is
 * a real capability and not a workaround dressed as one.
 */
export interface ShellPdfLauncherPort {
  newPdfTab(): Promise<void>
}

/**
 * Projects: the Home sidebar's grouping of files.
 *
 * `listFiles` returns refs, not paths. It used to return `string[]` paths that
 * the renderer relayed straight into `statPaths` — a path crossing the seam
 * twice with the renderer as the courier, which is the leak even though the
 * renderer never split it.
 *
 * `create` resolves to nothing although the bridge returns the new project: the
 * caller reloads the list, so surfacing the entry would be a capability no call
 * site consumes.
 */
export interface ShellProjectsPort {
  list(): Promise<ProjectSummaryEntry[]>
  listFiles(projectId: string): Promise<FileRef[]>
  create(name: string): Promise<void>
  rename(id: string, name: string): Promise<void>
  /** Soft-delete; the files stay where they are. */
  delete(id: string): Promise<void>
  moveFile(ref: FileRef, projectId: string): Promise<void>
}

/**
 * The signed-in account behind the sidebar entry.
 *
 * Modelled as a required port rather than a nullable one, unlike docs' shared
 * `genspark` port. That port is nullable because its two members *are* local CLI
 * calls (`aiGskStatus` / `aiGskLogin`) that a page cannot make. This one is a
 * generic account contract — status, sign in, progress, sign out — that today
 * happens to be implemented over the gsk CLI and that home-api.ts already
 * records as "to be upgraded to a signup/account system later". A browser host
 * backs it with a web sign-in instead of stubbing it.
 */
export interface ShellAccountPort {
  status(): Promise<AccountStatus>
  /** Start sign-in. Resolves to whether the flow could be launched at all. */
  login(): Promise<boolean>
  /** Progress for the sign-in started by `login`; returns an unsubscribe. */
  onLoginProgress(handler: (event: AccountLoginEvent) => void): () => void
  /** Re-open the pending sign-in URL — the rescue path when auto-open failed. */
  openLoginUrl(): Promise<void>
  logout(): Promise<void>
}

/**
 * UI language: the shared `LanguagePort`, all three members.
 *
 * It used to be the write half alone, because the shell's home page was the
 * only place the language could be changed. Every app's chrome now carries the
 * toggle, so the shell is a subscriber as much as a broadcaster — a switch made
 * in an editor tab has to reach the tab strip and the home page too.
 */
export type ShellLanguagePort = LanguagePort

/** The first-run tour's one piece of host state. */
export interface ShellOnboardingPort {
  /** Whether the tour has been completed or skipped. */
  seen(): Promise<boolean>
  /** Record that it has; it never shows again. */
  markSeen(): Promise<void>
}

/** The application itself, as the account menu and the tour present it. */
export interface ShellAppPort {
  /** Version string for the account menu's footer row. */
  version(): Promise<string>
  /** Open the GenTeam community page outside the app. */
  openGenTeam(): Promise<void>
}

/**
 * The tab strip, minus the two native menus.
 *
 * A `Pick` of the existing `TabsApi` rather than a re-declaration, so the strip's
 * contract has one definition and cannot drift (same move as `DocsTabsPort`).
 */
export type ShellTabsPort = Pick<TabsApi, 'list' | 'activate' | 'close' | 'reorder' | 'onChanged'>

/**
 * The two native popup menus behind the "+" and "all tabs" buttons.
 *
 * Split out of `ShellTabsPort` because these are the only members of the strip
 * that are native by *necessity* rather than by choice: the content area below
 * the strip is a WebContentsView that paints over any DOM dropdown the shell
 * renders, so the menus have to be OS menus (see tabs-api.ts). That constraint
 * is an Electron artefact and disappears entirely in a browser, where there is
 * no WebContentsView to paint over anything — so a web host does not back this
 * port, it renders the menus in the DOM instead. Modelling it as `X | null`
 * keeps that a decision the renderer must see, rather than two channels that
 * silently do nothing.
 */
export type ShellTabMenusPort = Pick<TabsApi, 'showMenu' | 'showNewMenu'>

/**
 * Reading the AI provider configuration.
 *
 * Split from the editing half for the same reason ports/ai.ts splits the AI
 * surface four ways: they are backed by different things. Reading a snapshot is
 * a report on which providers are configured — deliberately credential-free by
 * contract (ai-settings-api.ts: "a read never returns it"), so any host can
 * answer it. Writing needs a credential store, which the Electron host has
 * (`safeStorage`) and a browser does not.
 */
export type ShellAiSettingsPort = Pick<AiSettingsApi, 'get'>

/**
 * Editing the AI provider configuration: saving a provider, probing a model,
 * cancelling a probe.
 *
 * All three take an `apiKey`-bearing input, so they stand or fall together —
 * a host that can save a credential but not test one, or vice versa, is not a
 * usable settings screen. The whole port is therefore `X | null` on the
 * composition below: one honest decision at one call site rather than three that
 * can disagree, exactly as `DocsPdfExportPort` handles its three members.
 */
export type ShellAiSettingsEditorPort = Pick<AiSettingsApi, 'save' | 'test' | 'cancelTest'>

/** What the shell does with a tab whose editor reports unsaved work. */
export type ShellCloseDecision = 'close' | 'keep'

/** The close guard's question, handed to the renderer's prompt. */
export interface ShellCloseRequest {
  /** The tab being closed, for the prompt's wording. */
  tab: TabSummary
  /**
   * Ask the editor to save now; resolves to whether it succeeded.
   *
   * May be called more than once — a prompt that offers "Save" and is told the
   * save failed can let the user try again — and may not be called at all.
   */
  save(): Promise<boolean>
}

/**
 * Hosting editor surfaces as in-page frames.
 *
 * Null on Electron, where the editors are `WebContentsView` children positioned
 * by the main process over the shell's own DOM; a host that paints its editors
 * natively has no frames to hand out and must not claim it. The web host backs
 * it, and `AppFrame` renders frames exactly when this port is present.
 *
 * `setClosePrompt` is here rather than being a dialog the host puts up itself,
 * because the host is not allowed to render. Electron's close guard is a native
 * message box with Save / Don't Save / Cancel, raised by the main process; a
 * browser page has no such thing, and `window.confirm` can express two outcomes
 * where the guard needs three. So the *decision* is a React dialog in the shell,
 * and the host drives it: it asks the frame whether closing would lose work,
 * calls this prompt if so, and honours the answer — including running `save()`
 * back through the frame protocol into the editor's own save path, which is the
 * only place a save can happen.
 */
export interface ShellFramesPort {
  /**
   * The URL a tab's frame should load, or `null` for a tab that has no frame
   * (Home). Same-origin by construction — the editors are served under a path of
   * the shell's own origin, which is what keeps their AI calls same-origin and
   * their titles readable.
   */
  srcFor(tab: TabSummary): string | null
  /**
   * Attach the rendered iframe for a tab, or `null` when it unmounts. Called
   * from a React ref callback; the host talks to the frame through it.
   */
  register(id: string, frame: HTMLIFrameElement | null): void
  /** Install the renderer's unsaved-changes prompt. Called once, before any close. */
  setClosePrompt(prompt: (request: ShellCloseRequest) => Promise<ShellCloseDecision>): void
}

/**
 * The shell's composed platform (the `index.html` document).
 *
 * Seven members are `X | null`, and the nullability is the design rather than a
 * convenience. An *optional* member would let a host claim a capability and
 * silently no-op it — the renderer would offer "Reveal in folder" and nothing
 * would happen, which is exactly how the hand-written web shims failed. A
 * *required key* holding either the port or `null` cannot be faked: the renderer
 * has to test it before it can use it, so each command exists exactly when it
 * works.
 *
 *   - `projects` — Electron: @genoffice/project-store over the project IPC.
 *     Already effectively nullable before this phase: Home.tsx tested
 *     `typeof window.aiOfficeProject !== 'undefined'` and hid the whole sidebar
 *     panel when absent, because the Home renderer is also loaded outside the
 *     shell. That runtime `typeof` check is now a typed key. Null on the web
 *     host: @genoffice/project-store is `node:fs` keyed on absolute paths.
 *   - `tabMenus` — Electron: the native popup menus. See `ShellTabMenusPort` for
 *     why a browser backs this with DOM instead of claiming it.
 *   - `aiSettingsEditor` — Electron: `safeStorage`-backed credential writes. See
 *     `ShellAiSettingsEditorPort`. Null on the web host: the BFF loads its
 *     credentials from the environment at boot and exposes no write route.
 *   - `sheetsLauncher`, `browse` — Electron only; see each port.
 *   - `slidesLauncher` — backed by both, and nullable only because a host without a
 *     presentations build would have to say so; it is where `officeLauncher` split.
 *   - `pdfLauncher`, `frames` — web only; see each port. These two are the
 *     reason this is not simply a list of things a browser cannot do: a host
 *     may back capabilities the desktop one has no equivalent for, and the
 *     nullable-key shape says so in the same voice.
 *
 * The Electron host backs everything it did before, so nothing about the desktop
 * app changes.
 */
export interface ShellPlatform {
  language: ShellLanguagePort
  app: ShellAppPort
  onboarding: ShellOnboardingPort
  files: ShellFilesPort
  launcher: ShellLauncherPort
  sheetsLauncher: ShellSheetsLauncherPort | null
  slidesLauncher: ShellSlidesLauncherPort | null
  browse: ShellBrowsePort | null
  pdfLauncher: ShellPdfLauncherPort | null
  frames: ShellFramesPort | null
  projects: ShellProjectsPort | null
  account: ShellAccountPort
  tabs: ShellTabsPort
  tabMenus: ShellTabMenusPort | null
  aiSettings: ShellAiSettingsPort
  aiSettingsEditor: ShellAiSettingsEditorPort | null
}

/**
 * What a host module must export as `createShellPlatform`.
 *
 * Async because a browser host will have to open its handle store before it can
 * resolve a `FileRef`, matching `CreatePdfPlatform` / `CreateDocsPlatform`.
 *
 * Unlike those two, `main.tsx` imports this from `./host-electron` directly
 * rather than through a `@host` build-time alias. The alias exists to keep two
 * hosts' code out of each other's bundles; with one host it would only be
 * machinery. Phase 5b introduces it (and a `vite.shared.ts` beside the other
 * apps') at the moment there is a second host to point it at — the contract
 * `main.tsx` consumes is this type either way, so nothing else has to move.
 */
export type CreateShellPlatform = () => Promise<ShellPlatform>

export const { set: setShellPlatform, get: shellPlatform } =
  createPlatformSlot<ShellPlatform>('shell')

/**
 * The auto-update dialog's surface.
 *
 * An alias rather than a re-declaration: `UpdateWindowApi` is already
 * transport-agnostic (shared/update-api.ts imports nothing from Electron, and
 * the window's copy is localized in the main process and delivered as data), so
 * re-declaring it here would only create something to drift. Same reasoning as
 * `ProjectPort` aliasing `ProjectApi` in @genoffice/platform.
 */
export type UpdateWindowPort = UpdateWindowApi

/**
 * The update window's composed platform (the `update.html` document).
 *
 * One member, and its own slot: this document's preload exposes
 * `window.aiOfficeUpdate` and nothing else, so a host built for it can honour
 * none of `ShellPlatform`. A single slot would have to hold one composition or
 * the other and could only be typed by making most of it nullable — which would
 * say "this capability may be missing" about capabilities that are simply in a
 * different window.
 */
export interface UpdateWindowPlatform {
  update: UpdateWindowPort
}

/** What a host module must export as `createUpdateWindowPlatform`. */
export type CreateUpdateWindowPlatform = () => Promise<UpdateWindowPlatform>

export const { set: setUpdateWindowPlatform, get: updateWindowPlatform } =
  createPlatformSlot<UpdateWindowPlatform>('shell-update')
