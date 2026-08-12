/**
 * The editor surfaces, as in-page frames.
 *
 * Rendered only on a host that has a `frames` port — the web one. Electron
 * paints its editors as `WebContentsView` children of the shell window, so there
 * the port is null and this component never mounts.
 *
 * One iframe per tab, same origin, sub-path of the shell: `/app/docs`,
 * `/app/pdf`. Not one combined bundle, because two editors in one document would
 * have to reconcile two `#root` elements, two sets of unprefixed `:root` CSS
 * variables holding different values, two CSPs (pdf needs `wasm-unsafe-eval`,
 * docs does not), four document-level singletons both apps write, and some
 * twenty global listeners landing on one `window`. A frame is the browser's
 * `WebContentsView`, and it settles all of that the same way Electron does.
 *
 * Two behaviours are deliberate and worth stating:
 *
 *   - **Lazy.** A tab gets its frame the first time it is activated, so opening
 *     a tab in the background costs nothing. Same as the Electron shell, which
 *     creates the view when the tab opens and only then loads it.
 *   - **Kept alive.** A backgrounded frame is hidden, never unmounted.
 *     Unmounting would destroy the document and take its unsaved edits with it,
 *     which is precisely the thing the close guard exists to prevent — so the
 *     hidden state has to be a paint decision, not a lifecycle one. `visibility`
 *     rather than `display: none` for the same reason a `WebContentsView` is
 *     hidden rather than detached: the frame keeps its layout box, so switching
 *     back is a repaint rather than a relayout of a document that thinks it has
 *     zero width.
 *
 * The dialog at the bottom is the close guard's third of the work. The host asks
 * the frame whether closing would lose work and honours the answer; this is
 * where the answer is *asked for*, because a port cannot render. It offers the
 * same three outcomes as the native message box Electron raises — Save, Don't
 * Save, Cancel — and "Save" runs inside the frame, over the protocol, through
 * the editor's own save path. If that fails (a document that has never been
 * saved needs a file dialog, and a file dialog needs a click in the frame's own
 * window) the dialog says so and leaves the other two choices standing, rather
 * than closing the tab on a save that did not happen.
 */
import { useEffect, useRef, useState } from 'react'
import type { ShellCloseDecision, ShellCloseRequest, ShellFramesPort } from './platform'
import { shellPlatform } from './platform'
import type { TabSummary } from '../../shared/tabs-api'
import { useI18n } from './locale'
import './frames.css'

interface PendingClose {
  request: ShellCloseRequest
  decide: (decision: ShellCloseDecision) => void
}

export function FrameHost({ frames }: { frames: ShellFramesPort }) {
  const { t } = useI18n()
  const [tabs, setTabs] = useState<TabSummary[]>([])
  /** Tab ids that have been activated at least once, in mount order. */
  const [mounted, setMounted] = useState<string[]>([])
  const [pending, setPending] = useState<PendingClose | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  /**
   * One stable ref callback per frame, kept for the life of the component.
   *
   * React re-runs a ref callback whose *identity* changed, detaching with `null`
   * first — so an inline arrow would detach and reattach every frame on every
   * render. That is not cosmetic here: detaching tells the host the frame is
   * gone, which fails whatever it has in flight, and the close guard's own
   * dialog re-renders this component while a save request is outstanding. A
   * stable callback means a frame is registered exactly when it mounts and
   * detached exactly when it unmounts.
   */
  const frameRefs = useRef(new Map<string, (element: HTMLIFrameElement | null) => void>())
  const frameRef = (id: string) => {
    const existing = frameRefs.current.get(id)
    if (existing !== undefined) return existing
    const callback = (element: HTMLIFrameElement | null) => frames.register(id, element)
    frameRefs.current.set(id, callback)
    return callback
  }

  useEffect(() => {
    const port = shellPlatform().tabs
    void port.list().then(setTabs)
    return port.onChanged(setTabs)
  }, [])

  useEffect(() => {
    setMounted((prev) => {
      // Drop frames whose tabs are gone, then add the active tab if this is the
      // first time it has been shown. Returning `prev` unchanged when nothing
      // moved keeps this from re-rendering on every tab broadcast.
      const alive = prev.filter((id) => tabs.some((tab) => tab.id === id))
      const active = tabs.find((tab) => tab.active)
      const needsFrame = active !== undefined && frames.srcFor(active) !== null
      const next = needsFrame && !alive.includes(active.id) ? [...alive, active.id] : alive
      return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next
    })
  }, [tabs, frames])

  // Forget the ref callbacks of frames that are gone. Separate from the update
  // above so that updater stays a pure function of its input.
  useEffect(() => {
    for (const id of [...frameRefs.current.keys()]) {
      if (!mounted.includes(id)) frameRefs.current.delete(id)
    }
  }, [mounted])

  useEffect(() => {
    frames.setClosePrompt(
      (request) =>
        new Promise<ShellCloseDecision>((decide) => {
          setSaving(false)
          setSaveFailed(false)
          setPending({ request, decide })
        }),
    )
  }, [frames])

  // Focus the dialog when it appears so Escape and the buttons are reachable
  // from the keyboard without a click.
  useEffect(() => {
    if (pending !== null) dialogRef.current?.focus()
  }, [pending])

  const settle = (decision: ShellCloseDecision) => {
    pending?.decide(decision)
    setPending(null)
  }

  const saveThenClose = async () => {
    if (pending === null || saving) return
    setSaving(true)
    setSaveFailed(false)
    const ok = await pending.request.save()
    if (ok) {
      settle('close')
      return
    }
    // The tab stays open and the other two choices stay available: a failed save
    // must never be reported by closing the document anyway.
    setSaving(false)
    setSaveFailed(true)
  }

  return (
    <>
      {mounted.map((id) => {
        const tab = tabs.find((entry) => entry.id === id)
        if (tab === undefined) return null
        const src = frames.srcFor(tab)
        if (src === null) return null
        return (
          <iframe
            key={id}
            className="app-frame-view"
            title={tab.title}
            src={src}
            style={{ visibility: tab.active ? 'visible' : 'hidden' }}
            ref={frameRef(id)}
          />
        )
      })}
      {pending !== null && (
        <div className="frame-close-backdrop" role="presentation">
          <div
            className="frame-close-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="frame-close-title"
            tabIndex={-1}
            ref={dialogRef}
            onKeyDown={(event) => {
              if (event.key === 'Escape') settle('keep')
            }}
          >
            <h2 id="frame-close-title">{t('closeUnsavedTitle')}</h2>
            <p>{t('closeUnsavedBody', { name: pending.request.tab.title })}</p>
            {saveFailed && <p className="frame-close-error">{t('closeSaveFailed')}</p>}
            <div className="frame-close-actions">
              <button className="frame-close-secondary" onClick={() => settle('keep')}>
                {t('cancel')}
              </button>
              <button className="frame-close-secondary" onClick={() => settle('close')}>
                {t('dontSave')}
              </button>
              <button
                className="frame-close-primary"
                disabled={saving}
                onClick={() => void saveThenClose()}
              >
                {t('save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
