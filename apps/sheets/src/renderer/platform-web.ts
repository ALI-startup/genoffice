/** Builds sheets' platform for a browser. */
import type { AiPort, AttachmentsPort, LanguagePort } from '@samugen/platform'
import {
  createWebUnloadPrompt,
  ensurePermission,
  isPickerCancel,
  type FilePickerAcceptType,
  type FilePickers,
  type FrameChildLink,
  type WebFileHandle,
  openExternalUrl,
} from '@samugen/platform-web'
import { parsePivotDefinition } from '../gateway/xlsx-pivot'
import { readArchiveEntryText } from '../gateway/xlsx-package-io'
import { writeWorkbookTo } from '../gateway/workbook-save'
import {
  workbookFileSchema,
  workbookFormulaCellsResultSchema,
  workbookMediaResultSchema,
  workbookPivotDefinitionSchema,
  workbookRangeResultSchema,
  workbookRecalcResultSchema,
  type WorkbookFile,
  type WorkbookSaveResult,
} from '../shared/desktop-api'
import type { XlsxWorkerClient } from './wasm/client'
import { createEngineSaveFs } from './wasm/save-fs'
import type {
  SheetsAiPort,
  SheetsFilePort,
  SheetsLanguagePort,
  SheetsPlatform,
  SheetsWindowPort,
  SheetsWorkbookPort,
} from './platform'

/** The one format sheets opens and saves in a browser. `.xls`/`.csv` imports are §8. */
const WORKBOOK_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Excel Workbook',
    accept: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
    },
  },
]

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** One open workbook, as this host has to remember it. */
interface WebSession {
  /** Where the engine knows the bytes by. Never leaves this module. */
  enginePath: string
  /** The handle the user granted, or null for a workbook that has never been saved anywhere. */
  handle: WebFileHandle | null
  name: string
  sha256: string
  sheetNames: Map<string, string>
}

/** The sessions this page has open. */
export class WebWorkbookSessions {
  private readonly sessions = new Map<string, WebSession>()

  set(sessionId: string, session: WebSession): void {
    this.sessions.set(sessionId, session)
  }

  get(sessionId: string): WebSession {
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw new Error('Unknown workbook session.')
    return session
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}

/** The engine's answer to `open`, which is also most of a `WorkbookFile`. */
interface OpenedWorkbook {
  sessionId: string
  sheets: { id: string; name: string }[]
}

/** sha256 of the bytes as opened — the desktop's guard against a file that changed underneath. */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Reading a workbook: the five commands that are the engine, and nothing else. */
export function createWebSheetsWorkbookPort(
  sessions: WebWorkbookSessions,
  client: XlsxWorkerClient,
): SheetsWorkbookPort {
  return {
    readWorkbookRange: async (request) => {
      sessions.get(request.sessionId)
      return workbookRangeResultSchema.parse(await client.readRange(request))
    },
    readWorkbookFormulas: async (request) => {
      sessions.get(request.sessionId)
      return workbookFormulaCellsResultSchema.parse(await client.readFormulaCells(request))
    },
    readWorkbookMedia: async (request) => {
      sessions.get(request.sessionId)
      return workbookMediaResultSchema.parse(await client.readMedia(request))
    },
    /** Recalculation, with the same id↔name translation the desktop does. */
    recalcWorkbook: async (request) => {
      const session = sessions.get(request.sessionId)
      const fileSheetName = (sheetId: string): string => {
        const name = session.sheetNames.get(sheetId)
        if (name === undefined) throw new Error(`Unknown sheet for recalculation: ${sheetId}`)
        return name
      }
      const result = (await client.recalcCells({
        path: session.enginePath,
        edits: request.edits.map((edit) => ({
          sheet: fileSheetName(edit.sheetId),
          row: edit.row,
          column: edit.column,
          input: edit.input,
        })),
        reads: request.reads.map((read) => ({
          sheet: fileSheetName(read.sheetId),
          range: read.range,
        })),
      })) as {
        cells: {
          sheet: string
          row: number
          column: number
          formatted: string
          number?: number
          isFormula: boolean
        }[]
      }
      const idsByName = new Map([...session.sheetNames].map(([id, name]) => [name, id]))
      return workbookRecalcResultSchema.parse({
        cells: result.cells.flatMap((cell) => {
          const sheetId = idsByName.get(cell.sheet)
          if (sheetId === undefined) return []
          return [
            {
              sheetId,
              row: cell.row,
              column: cell.column,
              formatted: cell.formatted,
              ...(cell.number === undefined ? {} : { number: cell.number }),
              isFormula: cell.isFormula,
            },
          ]
        }),
      })
    },
    readPivotDefinition: async (request) => {
      const session = sessions.get(request.sessionId)
      const fs = createEngineSaveFs(client)
      const [pivotXml, cacheXml] = await Promise.all([
        readArchiveEntryText(client, fs, session.enginePath, request.path),
        readArchiveEntryText(client, fs, session.enginePath, request.cachePath),
      ])
      return workbookPivotDefinitionSchema.parse(parsePivotDefinition(pivotXml, cacheXml))
    },
  }
}

/** The host services the file port cannot answer for itself. */
export interface WebFileServices {
  pickers: FilePickers
  /** Ask the user to confirm overwriting a file another program changed. Blocking. */
  confirmOverwrite: () => boolean
}

/** Getting a workbook in and out of a page. */
export function createWebSheetsFilePort(
  sessions: WebWorkbookSessions,
  client: XlsxWorkerClient,
  services: WebFileServices,
): SheetsFilePort {
  /** Read a picked file, hand it to the engine, and record the session. */
  const adopt = async (
    handle: WebFileHandle | null,
    name: string,
    bytes: Uint8Array,
  ): Promise<WorkbookFile> => {
    const enginePath = await client.writeWorkbook(name, bytes)
    const [opened, digest] = await Promise.all([
      client.open(enginePath) as Promise<OpenedWorkbook>,
      sha256(bytes),
    ])
    sessions.set(opened.sessionId, {
      enginePath,
      handle,
      name,
      sha256: digest,
      sheetNames: new Map(opened.sheets.map((sheet) => [sheet.id, sheet.name])),
    })
    return workbookFileSchema.parse({
      ...opened,
      // `path` is what the renderer shows and hands back; on this host it is the file's name,
      // never a location, because a page has none to tell the truth about.
      name,
      sha256: digest,
      readOnly: false,
      needsSaveAs: handle === null,
    })
  }

  return {
    selectWorkbook: async () => {
      let handle: WebFileHandle
      try {
        handle = await services.pickers.openFile({
          types: WORKBOOK_TYPES,
          id: 'samugen-xlsx',
        })
      } catch (error) {
        if (isPickerCancel(error)) return null
        throw error
      }
      await ensurePermission(handle, 'read')
      const file = await handle.getFile()
      return adopt(handle, file.name, new Uint8Array(await file.arrayBuffer()))
    },

    saveWorkbookEdits: async (request): Promise<WorkbookSaveResult> => {
      const session = sessions.get(request.sessionId)
      let handle: WebFileHandle | null = session.handle
      if (request.mode === 'save-as' || handle === null) {
        try {
          handle = await services.pickers.saveFile({
            suggestedName: session.name.endsWith('.xlsx') ? session.name : `${session.name}.xlsx`,
            types: WORKBOOK_TYPES,
            id: 'samugen-xlsx',
          })
        } catch (error) {
          if (isPickerCancel(error)) return { canceled: true }
          throw error
        }
      }
      if (handle === null) throw new Error('No file to save into.')
      const target = handle
      await ensurePermission(target, 'readwrite')

      // The desktop refuses outright when the file changed under the open workbook, because its
      // save rewrites that file in place.
      if (target === session.handle) {
        const onDisk = new Uint8Array(await (await target.getFile()).arrayBuffer())
        if ((await sha256(onDisk)) !== session.sha256 && !services.confirmOverwrite()) {
          return { canceled: true }
        }
      }

      // The same pipeline the desktop runs, over the engine's filesystem: plan the patched
      // parts, reassemble the archive, verify every untouched entry survived byte for byte.
      const fs = createEngineSaveFs(client)
      const targetPath = `/tmp/save/out-${session.enginePath.replace(/\//g, '_')}.xlsx`
      const mutation = await writeWorkbookTo({
        client,
        fs,
        session: { path: session.enginePath, sheetNames: session.sheetNames },
        request,
        targetPath,
      })
      const saved = await client.readFile(targetPath)

      // Only now does anything leave the page.
      const writable = await target.createWritable()
      await writable.write(new Blob([saved as unknown as BlobPart], { type: XLSX_MIME }))
      await writable.close()

      // The saved bytes are the workbook now: the old session still streams the pre-save file,
      // so it is replaced by one over what was written — exactly what the main process does.
      await client.close(request.sessionId).catch(() => undefined)
      sessions.delete(request.sessionId)
      const file = await adopt(target, target.name, saved)
      return { canceled: false, file, touchedEntries: [...mutation.touchedEntries] }
    },

    writeWorkbookRecovery: async () => ({ ok: false }),

    autoRenameWorkbook: async () => ({ renamed: false }),

    closeWorkbook: async (sessionId) => {
      if (!sessions.has(sessionId)) return
      const session = sessions.get(sessionId)
      await client.close(sessionId).catch(() => undefined)
      await client.removeWorkbook(session.enginePath).catch(() => undefined)
      sessions.delete(sessionId)
    },

    consumeNewBlankWorkbook: async () => false,

    readLocalImage: async () => {
      throw new Error(
        'Inserting an image by file path is not available in the browser — attach the image ' +
          'to the conversation instead.',
      )
    },
  }
}

/** The window integration for a browser. */
export function createWebSheetsWindowPort(
  unloadPrompt: typeof createWebUnloadPrompt = createWebUnloadPrompt,
  frame: FrameChildLink | null = null,
  openExternal: (url: string) => void = (url) => {
    openExternalUrl(url)
  },
): SheetsWindowPort {
  let pendingEdits = 0
  const closeSaveListeners = new Set<() => void>()
  const isDirty = (): boolean => pendingEdits > 0
  unloadPrompt(isDirty)

  if (frame !== null) {
    frame.onCloseCheck(isDirty)
    frame.onCloseSave(() => {
      if (closeSaveListeners.size === 0) {
        frame.reportCloseSave(false)
        return
      }
      for (const listener of closeSaveListeners) listener()
    })
  }

  return {
    notifyPendingEdits: (count) => {
      pendingEdits = count
    },
    onCloseSaveRequest: (callback) => {
      closeSaveListeners.add(callback)
      return () => void closeSaveListeners.delete(callback)
    },
    reportCloseSaveResult: (ok) => frame?.reportCloseSave(ok),
    // Nothing outside this page renames the open workbook: the desktop's shell can, from its
    // Home list, and a page has no such list.
    onWorkbookRenamed: () => () => {},
    openExternal: async (url) => {
      openExternal(url)
    },
  }
}

/** The UI language, from the shared web language storage every app uses. */
export function createWebSheetsLanguagePort(language: LanguagePort): SheetsLanguagePort {
  return language
}

/** The AI port is the shared one verbatim: sheets uses exactly `AiPort`'s four members. */
export function createWebSheetsAiPort(shared: AiPort): SheetsAiPort {
  return shared
}

export interface WebSheetsPlatformDeps {
  client: XlsxWorkerClient
  pickers: FilePickers
  language: LanguagePort
  ai: AiPort
  attachments: AttachmentsPort
  confirmOverwrite: () => boolean
  /** Install a `beforeunload` guard; injected so tests can drive it. */
  unloadPrompt?: typeof createWebUnloadPrompt
  /** The web shell's frame link when this page is a tab of its strip, `null` standalone. */
  frame?: FrameChildLink | null
  /** Open a URL outside the app; injected so this module touches no global. */
  openExternal?: (url: string) => void
}

/** sheets' platform for a browser: six ports backed, five answered `null`. */
export function createWebSheetsPlatform(deps: WebSheetsPlatformDeps): SheetsPlatform {
  const sessions = new WebWorkbookSessions()
  return {
    workbook: createWebSheetsWorkbookPort(sessions, deps.client),
    file: createWebSheetsFilePort(sessions, deps.client, {
      pickers: deps.pickers,
      confirmOverwrite: deps.confirmOverwrite,
    }),
    window: createWebSheetsWindowPort(
      deps.unloadPrompt,
      deps.frame ?? null,
      ...(deps.openExternal === undefined ? [] : [deps.openExternal]),
    ),
    language: createWebSheetsLanguagePort(deps.language),
    ai: createWebSheetsAiPort(deps.ai),
    attachments: deps.attachments,
    menu: null,
    pdfExport: null,
    search: null,
    project: null,
  }
}
