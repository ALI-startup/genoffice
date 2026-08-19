import { describe, expect, it, vi } from 'vitest'
import type { PublicAiSettings, ShellFrameLink } from '@genoffice/platform-web'
import {
  createWebShellAccountPort,
  createWebShellAiSettingsPort,
  createWebShellFilesPort,
  createWebShellLauncherPort,
  createWebShellPdfLauncherPort,
  createWebShellSheetsLauncherPort,
  createWebShellSlidesLauncherPort,
  createWebShellTabs,
  parseRoute,
  routeFor,
  WEB_APP_PATHS,
  type RouteEnv,
  type Scheduler,
} from '../src/renderer/src/platform-web'
import type { ShellCloseDecision, ShellCloseRequest } from '../src/renderer/src/platform'
import type { TabSummary } from '../src/shared/tabs-api'

/**
 * The web shell's tab strip, router and close guard.
 *
 * Everything here is exercised through injected fakes, which is the point of the
 * adapters taking a route, a frame link and a scheduler rather than reaching for
 * `window`: the close guard in particular is a three-party handshake (shell →
 * frame → prompt → frame) and it has to be assertable without a browser.
 */

interface FakeRoute {
  env: RouteEnv
  /** Every hash pushed as a history entry, in order. */
  pushes: string[]
  current(): string
  /** Simulate Back/Forward or a pasted URL. */
  go(hash: string): void
}

function fakeRoute(initial = '#/'): FakeRoute {
  let hash = initial
  const pushes: string[] = []
  const handlers = new Set<() => void>()
  return {
    pushes,
    current: () => hash,
    go(next) {
      hash = next
      for (const handler of handlers) handler()
    },
    env: {
      hash: () => hash,
      push: (next) => {
        hash = next
        pushes.push(next)
      },
      replace: (next) => {
        hash = next
      },
      onChange: (handler) => {
        handlers.add(handler)
        return () => void handlers.delete(handler)
      },
    },
  }
}

interface FakeLink extends ShellFrameLink {
  dirty: Map<string, boolean>
  titles: Map<string, string>
  saveOk: boolean
  saves: string[]
  registered: Map<string, unknown>
}

function fakeLink(): FakeLink {
  const link: FakeLink = {
    dirty: new Map(),
    titles: new Map(),
    saveOk: true,
    saves: [],
    registered: new Map(),
    register: (id, target) => void link.registered.set(id, target),
    titleOf: (id) => link.titles.get(id) ?? null,
    isReady: () => true,
    wouldLoseWork: async (id) => link.dirty.get(id) ?? false,
    requestSave: async (id) => {
      link.saves.push(id)
      return link.saveOk
    },
    dispose: () => {},
  }
  return link
}

/** A scheduler that never fires on its own; the test calls `tick`. */
function manualScheduler(): { schedule: Scheduler; tick(): void } {
  let pending: (() => void) | null = null
  return {
    schedule: (fn) => {
      pending = fn
      return () => {
        pending = null
      }
    },
    tick: () => pending?.(),
  }
}

function setup(initialHash = '#/') {
  const route = fakeRoute(initialHash)
  const frames = fakeLink()
  const scheduler = manualScheduler()
  const shell = createWebShellTabs({
    route: route.env,
    frames,
    titleFor: (kind) =>
      kind === 'pdf'
        ? 'Open PDF'
        : kind === 'slides'
          ? 'AI Slides'
          : kind === 'sheets'
            ? 'AI Sheets'
            : 'AI Docs',
    homeTitle: 'GenOffice',
    schedule: scheduler.schedule,
  })
  return { route, frames, scheduler, shell }
}

const idsOf = (tabs: TabSummary[]) => tabs.map((tab) => tab.id)
const activeOf = (tabs: TabSummary[]) => tabs.find((tab) => tab.active)?.id

describe('routes', () => {
  it('round-trips a frame tab and pins Home at the root', () => {
    expect(routeFor({ id: 'home', kind: 'home' })).toBe('#/')
    expect(routeFor({ id: 't2', kind: 'pdf' })).toBe('#/pdf/t2')
    expect(parseRoute('#/pdf/t2')).toEqual({ id: 't2', kind: 'pdf' })
    expect(routeFor({ id: 't3', kind: 'slides' })).toBe('#/slides/t3')
    expect(parseRoute('#/slides/t3')).toEqual({ id: 't3', kind: 'slides' })
    expect(routeFor({ id: 't4', kind: 'sheets' })).toBe('#/sheets/t4')
    expect(parseRoute('#/sheets/t4')).toEqual({ id: 't4', kind: 'sheets' })
    expect(parseRoute('#/')).toBeNull()
    // Home is this shell's own page rather than a frame, so it is not routable as one.
    expect(parseRoute('#/home/t2')).toBeNull()
    expect(parseRoute('#/docs/../etc')).toBeNull()
  })
})

describe('web shell tabs', () => {
  it('starts with Home alone, active, and unclosable', async () => {
    const { shell } = setup()
    const tabs = await shell.tabs.list()
    expect(tabs).toEqual([
      { id: 'home', kind: 'home', title: 'GenOffice', closable: false, active: true },
    ])
  })

  it('opens a frame tab, activates it and puts it in the URL', async () => {
    const { shell, route } = setup()
    const id = shell.openTab('docs')
    expect(route.current()).toBe(`#/docs/${id}`)
    expect(route.pushes).toEqual([`#/docs/${id}`])
    const tabs = await shell.tabs.list()
    expect(idsOf(tabs)).toEqual(['home', id])
    expect(activeOf(tabs)).toBe(id)
    expect(tabs[1].title).toBe('AI Docs')
  })

  it('gives each frame tab a same-origin sub-path carrying its id', async () => {
    const { shell, frames } = setup()
    const id = shell.openTab('pdf')
    const [, tab] = await shell.tabs.list()
    const src = shell.frames.srcFor(tab)
    expect(src).toBe(`${WEB_APP_PATHS.pdf}?shellFrame=${id}`)
    expect(src?.startsWith('/')).toBe(true)
    expect(shell.frames.srcFor({ ...tab, kind: 'home' })).toBeNull()
    expect(frames.registered.size).toBe(0)
  })

  it('hosts a sheets frame under its own sub-path', async () => {
    const { shell } = setup()
    const id = shell.openTab('sheets')
    const [, tab] = await shell.tabs.list()
    expect(tab.title).toBe('AI Sheets')
    expect(shell.frames.srcFor(tab)).toBe(`${WEB_APP_PATHS.sheets}?shellFrame=${id}`)
  })

  it('hosts a slides frame under its own sub-path', async () => {
    const { shell } = setup()
    const id = shell.openTab('slides')
    const [, tab] = await shell.tabs.list()
    expect(tab.title).toBe('AI Slides')
    expect(shell.frames.srcFor(tab)).toBe(`${WEB_APP_PATHS.slides}?shellFrame=${id}`)
  })

  it('broadcasts every change to subscribers', async () => {
    const { shell } = setup()
    const seen: TabSummary[][] = []
    shell.tabs.onChanged((tabs) => seen.push(tabs))
    const id = shell.openTab('docs')
    await shell.tabs.activate('home')
    expect(seen.map(activeOf)).toEqual([id, 'home'])
  })

  it('reorders tabs but never past Home', async () => {
    const { shell } = setup()
    const a = shell.openTab('docs')
    const b = shell.openTab('pdf')
    await shell.tabs.reorder(b, 1)
    expect(idsOf(await shell.tabs.list())).toEqual(['home', b, a])
    await shell.tabs.reorder(a, 0)
    expect(idsOf(await shell.tabs.list())).toEqual(['home', a, b])
    await shell.tabs.reorder('home', 2)
    expect(idsOf(await shell.tabs.list())).toEqual(['home', a, b])
  })

  it('adopts the tab named by the URL at startup', async () => {
    const { shell } = setup('#/pdf/t7')
    const tabs = await shell.tabs.list()
    expect(idsOf(tabs)).toEqual(['home', 't7'])
    expect(activeOf(tabs)).toBe('t7')
    // The next tab must not reuse the adopted id.
    expect(shell.openTab('docs')).toBe('t8')
  })

  it('follows Back and Forward, reopening a tab the URL still names', async () => {
    const { shell, route } = setup()
    const id = shell.openTab('docs')
    route.go('#/')
    expect(activeOf(await shell.tabs.list())).toBe('home')
    route.go(`#/docs/${id}`)
    expect(activeOf(await shell.tabs.list())).toBe(id)
    await shell.tabs.close(id)
    route.go(`#/docs/${id}`)
    expect(idsOf(await shell.tabs.list())).toEqual(['home', id])
  })

  it('adopts each frame title from its own document', async () => {
    const { shell, frames, scheduler } = setup()
    const id = shell.openTab('docs')
    frames.titles.set(id, 'Quarterly report.docx')
    scheduler.tick()
    expect((await shell.tabs.list())[1].title).toBe('Quarterly report.docx')
    // An untitled document leaves the placeholder standing rather than blanking it.
    frames.titles.delete(id)
    scheduler.tick()
    expect((await shell.tabs.list())[1].title).toBe('Quarterly report.docx')
  })
})

describe('close guard', () => {
  const prompt = (decision: ShellCloseDecision) =>
    vi.fn(async (_request: ShellCloseRequest) => decision)

  it('closes a clean tab without asking', async () => {
    const { shell } = setup()
    const ask = prompt('keep')
    shell.frames.setClosePrompt(ask)
    const id = shell.openTab('docs')
    await shell.tabs.close(id)
    expect(ask).not.toHaveBeenCalled()
    expect(idsOf(await shell.tabs.list())).toEqual(['home'])
  })

  it('never closes Home', async () => {
    const { shell } = setup()
    await shell.tabs.close('home')
    expect(idsOf(await shell.tabs.list())).toEqual(['home'])
  })

  it('asks before closing a dirty tab, and keeps it on cancel', async () => {
    const { shell, frames } = setup()
    const ask = prompt('keep')
    shell.frames.setClosePrompt(ask)
    const id = shell.openTab('docs')
    frames.dirty.set(id, true)
    await shell.tabs.activate('home')
    await shell.tabs.close(id)
    expect(ask).toHaveBeenCalledTimes(1)
    // The tab is brought into view first, so the prompt has visible context.
    expect(activeOf(await shell.tabs.list())).toBe(id)
    expect(idsOf(await shell.tabs.list())).toEqual(['home', id])
  })

  it('closes on an explicit discard', async () => {
    const { shell, frames } = setup()
    shell.frames.setClosePrompt(prompt('close'))
    const id = shell.openTab('docs')
    frames.dirty.set(id, true)
    await shell.tabs.close(id)
    expect(idsOf(await shell.tabs.list())).toEqual(['home'])
    expect(frames.registered.get(id)).toBeNull()
  })

  it('routes a Save through the frame, and reports failure back to the prompt', async () => {
    const { shell, frames } = setup()
    const id = shell.openTab('docs')
    frames.dirty.set(id, true)
    frames.saveOk = false
    let sawFailure = false
    shell.frames.setClosePrompt(async (request) => {
      sawFailure = (await request.save()) === false
      return 'keep'
    })
    await shell.tabs.close(id)
    expect(frames.saves).toEqual([id])
    expect(sawFailure).toBe(true)
    expect(idsOf(await shell.tabs.list())).toEqual(['home', id])

    frames.saveOk = true
    shell.frames.setClosePrompt(async (request) => ((await request.save()) ? 'close' : 'keep'))
    await shell.tabs.close(id)
    expect(idsOf(await shell.tabs.list())).toEqual(['home'])
  })

  it('keeps a dirty tab open when no prompt is installed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { shell, frames } = setup()
    const id = shell.openTab('docs')
    frames.dirty.set(id, true)
    await shell.tabs.close(id)
    expect(idsOf(await shell.tabs.list())).toEqual(['home', id])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not stack dialogs when close is clicked twice', async () => {
    const { shell, frames } = setup()
    const id = shell.openTab('docs')
    frames.dirty.set(id, true)
    let asked = 0
    let release: (() => void) | null = null
    shell.frames.setClosePrompt(
      () =>
        new Promise<ShellCloseDecision>((resolve) => {
          asked += 1
          release = () => resolve('keep')
        }),
    )
    const first = shell.tabs.close(id)
    await shell.tabs.close(id)
    expect(asked).toBe(1)
    release!()
    await first
  })

  it('falls back to the neighbouring tab when the active one closes', async () => {
    const { shell, route } = setup()
    const a = shell.openTab('docs')
    const b = shell.openTab('pdf')
    await shell.tabs.close(b)
    expect(activeOf(await shell.tabs.list())).toBe(a)
    // A correction the user did not ask for is a replace, not a new history entry.
    expect(route.current()).toBe(`#/docs/${a}`)
    expect(route.pushes).toEqual([`#/docs/${a}`, `#/pdf/${b}`])
  })
})

describe('web shell files port', () => {
  it('reports empty lists and warns on anything that needs a ref', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const files = createWebShellFilesPort()
    expect(await files.recents()).toEqual({ entries: [], total: 0, totalAll: 0 })
    expect(await files.starred()).toEqual({ entries: [], total: 0, totalAll: 0 })
    expect(files.reveal).toBeNull()
    expect(await files.statFiles(['x'])).toEqual([])
    expect(await files.rename('x', 'y')).toMatchObject({ ok: false })
    await files.toggleStar('x')
    await files.duplicate('x')
    await files.deleteFiles(['x'])
    await files.removeRecent(['x'])
    expect(warn).toHaveBeenCalledTimes(6)
    warn.mockRestore()
  })
})

describe('web shell account port', () => {
  it('reports signed out and cannot launch a sign-in', async () => {
    const account = createWebShellAccountPort()
    expect(await account.status()).toEqual({ loggedIn: false })
    expect(await account.login()).toBe(false)
    // A real subscription with no emissions; unsubscribing is still valid.
    expect(typeof account.onLoginProgress(() => {})).toBe('function')
  })
})

describe('web shell launcher', () => {
  it('opens a docs tab for a new document and a pdf tab for the empty pdf surface', async () => {
    const opened: string[] = []
    const launcher = createWebShellLauncherPort((kind) => opened.push(kind))
    const pdf = createWebShellPdfLauncherPort((kind) => opened.push(kind))
    const slides = createWebShellSlidesLauncherPort((kind) => opened.push(kind))
    const sheets = createWebShellSheetsLauncherPort((kind) => opened.push(kind))
    await launcher.newDoc()
    await pdf.newPdfTab()
    // The project a new document belongs to has no meaning on this host, and is dropped
    // rather than refused: `projects` is null here, so nothing can supply one.
    await slides.newSlide({ projectId: 'p1' })
    await sheets.newSheet()
    expect(opened).toEqual(['docs', 'pdf', 'slides', 'sheets'])
  })

  it('warns rather than pretending when handed a ref it never issued', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await createWebShellLauncherPort(() => {}).open('/some/path.docx')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('read-only AI settings', () => {
  const published: PublicAiSettings = {
    version: 1,
    active: { providerId: 'anthropic', model: 'claude-sonnet-4-5' },
    providers: {
      anthropic: {
        providerId: 'anthropic',
        model: 'claude-sonnet-4-5',
        credentialConfigured: true,
      },
      openai: { providerId: 'openai', model: 'gpt-5', credentialConfigured: false },
      custom: {
        providerId: 'custom',
        model: 'local-model',
        baseUrl: 'http://127.0.0.1:1234/v1',
        credentialConfigured: false,
      },
    },
  }

  it('reports the active provider and which providers hold a credential', async () => {
    const port = createWebShellAiSettingsPort(async () => published)
    const snapshot = await port.get()
    expect(snapshot.activeProvider).toBe('anthropic')
    expect(snapshot.activeModel).toBe('claude-sonnet-4-5')
    const configured = snapshot.providers.filter((provider) => provider.credentialSet)
    expect(configured.map((provider) => provider.providerId)).toEqual(['anthropic'])
    expect(snapshot.providers.find((provider) => provider.providerId === 'custom')?.baseUrl).toBe(
      'http://127.0.0.1:1234/v1',
    )
  })

  it('never carries a credential hint, not even a masked one', async () => {
    const port = createWebShellAiSettingsPort(async () => published)
    const snapshot = await port.get()
    for (const provider of snapshot.providers) expect(provider.credentialHint).toBeUndefined()
    expect(JSON.stringify(snapshot)).not.toContain('••••')
  })

  it('marks no image provider active, because the server publishes none', async () => {
    const port = createWebShellAiSettingsPort(async () => published)
    const snapshot = await port.get()
    expect(snapshot.imageProvider).toBe('')
    expect(snapshot.imageModel).toBe('')
  })

  it('lists every provider the runtime registry knows, not only the published ones', async () => {
    const port = createWebShellAiSettingsPort(async () => published)
    const snapshot = await port.get()
    expect(snapshot.providers.length).toBe(snapshot.definitions.length)
    expect(snapshot.providers.length).toBeGreaterThan(3)
  })
})
