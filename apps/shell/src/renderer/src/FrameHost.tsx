/** The editor surfaces, as in-page frames. */
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
  /** One stable ref callback per frame, kept for the life of the component. */
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
      // Drop frames whose tabs are gone, then add the active tab if this is the first time it has
      // been shown.
      const alive = prev.filter((id) => tabs.some((tab) => tab.id === id))
      const active = tabs.find((tab) => tab.active)
      const needsFrame = active !== undefined && frames.srcFor(active) !== null
      const next = needsFrame && !alive.includes(active.id) ? [...alive, active.id] : alive
      return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next
    })
  }, [tabs, frames])

  // Forget the ref callbacks of frames that are gone.
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
