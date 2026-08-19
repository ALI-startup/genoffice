/**
 * Builds pdf's platform for a browser, from a `WebDocumentStore`.
 *
 * The mirror of platform-electron.ts, and it follows the same division: the
 * shared ports come from @samugen/platform-web, and the two app-specific
 * surfaces — the document operations and the Save As handshake — are adapted
 * here, next to the port declarations they satisfy. Nothing in this file touches
 * a browser global: the store, the pickers and the language/window environments
 * are all passed in, so this module is exercisable without a real `window`, and
 * host-web.ts is the only file that reads globals.
 *
 * Where Electron's file port is a rename (its `DocumentRef` *is* a path, so it
 * forwards to IPC), this one does the work in the renderer: the document's bytes
 * come from a `FileSystemFileHandle` and the editing runs here, through
 * @samugen/pdf-edit — byte-for-byte the same `savePdf` / `extractPagesBytes` /
 * `insertPdfBytes` the Electron main process calls. That is the point of
 * pdf-edit being host-agnostic: the browser gets the same editing behaviour
 * rather than a second implementation of it.
 */
import { extractPagesBytes, insertPdfBytes, savePdf } from '@samugen/pdf-edit'
import type { AiPort, LanguagePort } from '@samugen/platform'
import type { WebDocumentStore, WebWindowSlice } from '@samugen/platform-web'
import type {
  ExportImagesResult,
  ExtractPagesResult,
  InsertPdfResult,
  SavePdfResult,
} from '../shared/ipc'
import type { PdfFilePort, PdfPlatform, PdfWindowPort } from './platform'

export interface WebPdfPlatformDeps {
  store: WebDocumentStore
  language: LanguagePort
  ai: AiPort
  /** The dirty-state / close-guard slice; the Save As trio is added below. */
  window: WebWindowSlice
}

/**
 * pdf's document surface over the File System Access API.
 *
 * Every operation the Electron main process performs on disk has an exact
 * counterpart here, and the results keep the shapes shared/ipc declares. The
 * `savedPath` / `savedDir` fields carry the picked *name* rather than a path,
 * which is all a browser has and all the renderer uses them for — it reads only
 * `ok`, `error` and the presence of `canceled`.
 */
export function createWebPdfFilePort(store: WebDocumentStore): PdfFilePort {
  return {
    /**
     * Always null, and honestly so: "pending" means a host queued a document
     * into this view when it created it. A browser tab is opened by the user,
     * not by a host with a document in hand, so there is never anything queued.
     * This is what makes the renderer's `empty` state reachable on first load,
     * and why `openDocument` below has to exist.
     */
    consumePending: async () => null,

    openDocument: async () => {
      const picked = await store.open()
      // A browser handle exposes no path, so `location` is omitted rather than
      // invented — the field is optional for exactly this host.
      return picked ? { ref: picked.ref, name: picked.name } : null
    },

    readFile: async (ref) => toArrayBuffer(await store.read(ref)),

    save: ({ ref, target, ...edits }): Promise<SavePdfResult> =>
      attempt(async () => {
        // Save As reads the source and writes somewhere else; an in-place save
        // reads and writes the same document. `savePdf` does not care which,
        // and only writes once the whole edit applied cleanly.
        const io =
          target === undefined
            ? store.bytesIo(ref)
            : {
                read: () => store.read(ref),
                write: (bytes: Uint8Array) => store.write(target, bytes),
              }
        await savePdf(io, edits)
        return { ok: true } as const
      }),

    extractPages: ({ ref, pages, suggestedName }): Promise<ExtractPagesResult> =>
      attempt(async () => {
        const extracted = await extractPagesBytes(await store.read(ref), pages)
        const savedAs = await store.saveBytesAs(suggestedName, extracted)
        return savedAs === null
          ? ({ ok: true, canceled: true } as const)
          : ({ ok: true, savedPath: savedAs } as const)
      }),

    insertPdf: ({ ref, afterPageIndex }): Promise<InsertPdfResult> =>
      attempt(async () => {
        const other = await store.pickBytes()
        if (other === null) return { ok: true, canceled: true } as const
        const { merged, count } = await insertPdfBytes(await store.read(ref), other, afterPageIndex)
        // Electron writes the merge back immediately, and so does this: the
        // renderer reloads from the document straight after.
        await store.write(ref, merged)
        return { ok: true, insertedCount: count } as const
      }),

    exportImages: ({ images, pageNumbers, baseName }): Promise<ExportImagesResult> =>
      attempt(async () => {
        const directory = await store.pickDirectory()
        if (directory === null) return { ok: true, canceled: true } as const
        for (const [index, base64] of images.entries()) {
          const page = pageNumbers[index] ?? index + 1
          await directory.writeFile(`${baseName}-${page}.png`, fromBase64(base64))
        }
        return { ok: true, savedDir: directory.name, count: images.length } as const
      }),
  }
}

/**
 * The window surface. Two of the three Save As members are event sources this
 * host never emits for, which is the same honest arrangement
 * @samugen/platform-web's `createWebWindowPort` documents for the close guard:
 * the Save As request comes from the shell's menu, and there is no shell.
 *
 * `onSaveAsFlow` is different — it is wired to something real. Its contract is
 * "pause autosave while a host dialog is open", and it exists because a dialog
 * blurs the window while the blur is what triggers autosave. Every browser
 * picker blurs the window, so the store's `onDialog` is a strictly better
 * source than the Electron original: it covers the open, insert and export
 * pickers too, not just Save As.
 */
export function createWebPdfWindowPort(
  slice: WebWindowSlice,
  store: WebDocumentStore,
): PdfWindowPort {
  return {
    ...slice,
    onSaveAsRequest: () => () => {
      // Subscribing is legitimate; being called back never happens here.
    },
    reportSaveAsResult: (ok: boolean) => {
      console.warn(
        `[pdf] Save As result (${ok}) reported, but this host never issues a Save As request. ` +
          `Something is calling the reply half of the handshake directly.`,
      )
    },
    onSaveAsFlow: (handler) => store.onDialog(handler),
  }
}

export function createWebPdfPlatform(deps: WebPdfPlatformDeps): PdfPlatform {
  return {
    language: deps.language,
    ai: deps.ai,
    window: createWebPdfWindowPort(deps.window, deps.store),
    file: createWebPdfFilePort(deps.store),
  }
}

/**
 * Turn a thrown failure into the `{ ok: false, error }` shape these channels
 * use. The Electron main process converts its exceptions at the IPC boundary;
 * with no IPC boundary in the browser, this is where it happens — the renderer
 * reads `result.error` and must not have to catch as well.
 */
async function attempt<T extends { ok: true }>(
  run: () => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  try {
    return await run()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * `readFile` is declared as returning an `ArrayBuffer` because that is what the
 * Electron IPC channel hands back. Copying the view's own bounds out keeps the
 * two hosts' results identical even when the store returns a view over a larger
 * pooled buffer.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** The renderer rasterizes pages to base64 PNG (that is what the channel carries); a browser writes bytes. */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
