import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CircleHelp, ExternalLink, Info, Link2, Loader2, Moon, Orbit, SearchX, Square, Sun, TriangleAlert, X } from 'lucide-react'
import { Popover } from 'radix-ui'

import { BlinkPlayer } from '@/components/BlinkPlayer'
import { SkyContextPanel } from '@/components/SkyContextPanel'
import { CuratedList } from '@/components/CuratedList'
import { Tour } from '@/components/Tour'
import { CustomPanel, type CustomRequest, type LiveProgress } from '@/components/CustomPanel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  API_URL,
  ApiError,
  fetchLivePlan,
  loadCuratedIndex,
  loadCuratedSpectrum,
  loadCuratedTarget,
  loadManifest,
  type Manifest,
  refineLive,
  StaticDataError,
} from '@/lib/api'
import { describeFailures, LiveStack } from '@/lib/live'
import { coreSaturated, motionPxPerYear } from '@/lib/render'
import type { DataSource, Motion, SpectrumData, TargetData, TargetIndexEntry } from '@/lib/types'
import { guideSeen } from '@/lib/prefs'
import { applyTheme, currentTheme, type Theme } from '@/lib/theme'
import { copyText, type DisplayState, readUrl, sameSource, toSearch } from '@/lib/url'

type IndexState =
  | { status: 'loading' }
  | { status: 'ok'; targets: TargetIndexEntry[] }
  | { status: 'error'; missing: boolean; message: string }

type Tab = 'curated' | 'custom'

interface Shown {
  data: TargetData
  source: DataSource
  spectrum?: { live: SpectrumData } | { load: () => Promise<SpectrumData | null> }
}

// --- helpers --------------------------------------------------------------------

function fmtCoord(v: number, signed = false): string {
  return `${signed && v >= 0 ? '+' : ''}${v.toFixed(4)}°`
}

const REPO_URL = 'https://github.com/nimjal/waveshift'

/** GitHub mark (Octicons mark-github, MIT); lucide no longer ships brand icons. */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

function SourceLink() {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label="Source code on GitHub (opens in a new tab)"
    >
      <GitHubMark className="size-4" />
      Source
    </a>
  )
}

function CopyLinkButton() {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = window.setTimeout(() => setState('idle'), 2000)
    return () => window.clearTimeout(t)
  }, [state])
  return (
    <Button
      size="sm"
      variant="outline"
      className="shrink-0"
      onClick={() => void copyText(window.location.href).then((ok) => setState(ok ? 'copied' : 'failed'))}
      aria-live="polite"
    >
      {state === 'copied' ? <Check /> : <Link2 />}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed: use the address bar' : 'Copy link'}
    </Button>
  )
}

const NOT_MEASURABLE: Record<NonNullable<Motion['reason']>, string> = {
  saturated: 'the target is saturated in every detector',
  ambiguous: 'the brightest source jumps between epochs, so it may not be the same object',
  faint: 'the target is too faint to centroid',
  no_data: 'the target has no usable data in some epoch',
}

/** The mark: one star printed at three epochs, in the page's three inks. */
function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 46 28" className={className} aria-hidden="true">
      <g className="mark">
        <circle className="mark-a" cx="14" cy="14" r="10" fill="#22d3ee" />
        <circle cx="23" cy="14" r="10" fill="#f0519b" />
        <circle className="mark-c" cx="32" cy="14" r="10" fill="#fbbf24" />
      </g>
    </svg>
  )
}

const px = (v: number) => `${v.toFixed(2)} px`

function Readout({
  label,
  glyph,
  note,
  children,
}: {
  label: string
  glyph?: React.ReactNode
  note?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-1 basis-36 flex-col gap-1 bg-background px-3 py-3 sm:basis-44 sm:px-4">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {glyph}
        {label}
      </dt>
      <dd className="readout-value">{children}</dd>
      {note && <dd className="text-xs text-muted-foreground">{note}</dd>}
    </div>
  )
}

const GLYPH = {
  predicted: <span className="inline-block h-3 w-0.5 rounded-full" style={{ background: 'var(--ink-cyan)' }} />,
  measured: <span className="inline-block size-2 rounded-full bg-foreground" />,
  reference: <span className="inline-block size-2 rounded-full border border-muted-foreground" />,
}

/** Measured against predicted on one axis: the cyan bar is the prediction (same ink as the
 * reticle), the solid dot is the measurement, the hollow dot is the star that shouldn't move. */
function ShiftScale({ m }: { m: Motion }) {
  if (!m.measurable || m.measured_px === null) return null
  const ref = m.null_test?.measurable && m.null_test.measured_px !== null ? m.null_test.measured_px : null
  const top = Math.max(m.predicted_px, m.measured_px, ref ?? 0) * 1.12
  if (!Number.isFinite(top) || top <= 0) return null
  const at = (v: number) => `${Math.min(100, Math.max(0, (100 * v) / top))}%`
  return (
    <div className="basis-full bg-background px-3 pt-3 pb-2 sm:px-4" aria-hidden="true">
      <div className="relative h-5">
        <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
        <div className="absolute top-1/2 left-0 h-2.5 w-px -translate-y-1/2 bg-muted-foreground" />
        <div className="absolute top-1/2 right-0 h-2.5 w-px -translate-y-1/2 bg-muted-foreground" />
        {ref !== null && (
          <span
            className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-muted-foreground bg-background"
            style={{ left: at(ref) }}
          />
        )}
        <span
          className="absolute top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: at(m.predicted_px), background: 'var(--ink-cyan)' }}
        />
        <span
          className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-background"
          style={{ left: at(m.measured_px) }}
        />
      </div>
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
        <span>0</span>
        <span>{px(top)}</span>
      </div>
    </div>
  )
}

function MotionReadouts({ m }: { m: Motion }) {
  const nt = m.null_test
  return (
    <>
      <Readout label="Predicted shift" glyph={GLYPH.predicted} note={`Epoch ${m.from_epoch} to ${m.to_epoch}`}>
        {px(m.predicted_px)}
      </Readout>
      <Readout
        label="Measured shift"
        glyph={GLYPH.measured}
        note={
          m.measurable && m.measured_px !== null
            ? `Centroid, ${m.detector ?? 'reddest usable detector'}`
            : m.reason
              ? NOT_MEASURABLE[m.reason]
              : 'no usable detector'
        }
      >
        {m.measurable && m.measured_px !== null ? px(m.measured_px) : <span className="text-lg text-muted-foreground">Not measurable</span>}
      </Readout>
      {nt && (
        <Readout
          label="Reference star"
          glyph={GLYPH.reference}
          note={
            nt.measurable && nt.measured_px !== null
              ? 'Should be about 0'
              : `not measurable (${nt.reason === 'faint' ? 'too faint' : (nt.reason?.replace('_', ' ') ?? 'no data')})`
          }
        >
          {nt.measurable && nt.measured_px !== null ? px(nt.measured_px) : <span className="text-muted-foreground">–</span>}
        </Readout>
      )}
      <ShiftScale m={m} />
    </>
  )
}

/** How the shift was measured: the fine print under the readouts. */
function MotionMethod({ m }: { m: Motion }) {
  const nt = m.null_test
  return (
    <p>
      Centroid estimate: {m.window_px}×{m.window_px} px window on each epoch's brightest pixel within{' '}
      {m.search.radius_px.toFixed(1)} px of the track, in {m.detector ?? 'the reddest usable detector'}.
      {nt?.measurable && (
        <>
          {' '}
          The reference star (x {nt.x}, y {nt.y}
          {nt.detector ? `, ${nt.detector}` : ''}) doesn't move, so its shift should be ~0: a check that the method
          doesn't invent motion, not the error on the target's shift.
        </>
      )}
    </p>
  )
}

/** Tap/click info bubble (a hover tooltip wouldn't open on phones). */
function StackInfo({ live }: { live: boolean }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1 align-middle text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          <Info className="size-3.5" />
          {live ? 'mean stack' : 'median stack'}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 max-w-72 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
        >
          Live views use a mean stack; curated targets use a median stack.{' '}
          <span className="text-muted-foreground">
            A live view is summed a batch at a time while it refines, and a median can't be built up that way. A mean
            is more sensitive to outliers such as cosmic rays or satellite trails.
          </span>
          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function TargetHeader({ shown }: { shown: Shown }) {
  const { data, source } = shown
  const t = data.target
  const pxPerYr = motionPxPerYear(data)
  const years = data.epochs.length > 1 ? data.epochs[data.epochs.length - 1].year_mid - data.epochs[0].year_mid : 0
  const pmTotal = Math.hypot(t.pmra, t.pmdec)
  const m = data.motion

  return (
    <header className="mb-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-80">
          <p className="mb-2 flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="capitalize">
              {t.kind}
            </Badge>
            {source.kind === 'custom' && <Badge variant="outline">live</Badge>}
          </p>
          <h2 className="display stage-title">{t.name}</h2>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            RA {fmtCoord(data.grid.center_ra)} · Dec {fmtCoord(data.grid.center_dec, true)} (field centre,{' '}
            {data.grid.center_epoch}) · {data.grid.size_px}×{data.grid.size_px} px at {data.grid.pixel_scale_arcsec}″/px
          </p>
        </div>
        <CopyLinkButton />
      </div>

      {(pmTotal > 0 || m) && (
        <dl className="flex flex-wrap gap-px overflow-hidden rounded-md border border-border bg-border">
          {pmTotal > 0 && (
            <Readout label="Proper motion" note={`${pxPerYr.toFixed(2)} px/yr on this grid`}>
              {(pmTotal / 1000).toFixed(2)}″/yr
            </Readout>
          )}
          {m ? (
            <MotionReadouts m={m} />
          ) : (
            years > 0 && (
              <Readout label="Expected shift" glyph={GLYPH.predicted} note={`Across these ${data.epochs.length} epochs`}>
                ~{(pxPerYr * years).toFixed(1)} px
              </Readout>
            )
          )}
        </dl>
      )}

      <div className="flex max-w-[78ch] flex-col gap-1.5 text-sm text-muted-foreground">
        {pmTotal > 0 ? (
          <p className="text-foreground">
            {years > 0 && (
              <>
                Expect a shift of ~{(pxPerYr * years).toFixed(1)} px across these {data.epochs.length} epochs.{' '}
              </>
            )}
            The cyan reticle marks where it should be in each epoch.
          </p>
        ) : (
          <p className="text-foreground">
            Custom position with no known proper motion: the reticle marks the field centre. Look for anything that
            shifts or changes brightness between epochs.
          </p>
        )}
        {m?.measurable && m.measured_px !== null && <MotionMethod m={m} />}
        {coreSaturated(data) && (
          <p className="flex items-center gap-1.5 text-foreground">
            <TriangleAlert className="size-4 shrink-0 text-amber-500" />
            Core saturated in near-IR: brightness changes show in the surrounding glow.
          </p>
        )}
        <p className="text-xs">
          {data.n_used} of {data.n_images} images used · <StackInfo live={source.kind === 'custom'} /> ·{' '}
          {data.collections.join(', ') || 'no collections'} · built {new Date(data.generated_at).toLocaleString()}
        </p>
      </div>
    </header>
  )
}

// --- app ------------------------------------------------------------------------

export default function App() {
  const [initialUrl] = useState(() => readUrl())
  /** ?embed=1: player only, for an <iframe> on another site */
  const embed = initialUrl.embed
  const initialCustom = initialUrl.source?.kind === 'custom' ? initialUrl.source : null
  const [tab, setTab] = useState<Tab>(initialCustom ? 'custom' : 'curated')
  const [display, setDisplay] = useState<DisplayState>(initialUrl.display)
  /** link parameters that were ignored (bad link): shown once as a dismissible notice */
  const [notice, setNotice] = useState<string[]>(() =>
    initialCustom && !API_URL
      ? [...initialUrl.problems, 'custom coordinates need the live API, which this site does not have']
      : initialUrl.problems,
  )
  const [index, setIndex] = useState<IndexState>({ status: 'loading' })
  const [shown, setShown] = useState<Shown | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [curatedError, setCuratedError] = useState<string | null>(null)
  const [customReq, setCustomReq] = useState<CustomRequest>({ status: 'idle' })
  const [customResult, setCustomResult] = useState<Shown | null>(null)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  /** first-time visitors get the guided tour once; the "?" button replays it */
  const [tourOpen, setTourOpen] = useState(() => !embed && !guideSeen())
  const closeTour = useCallback(() => setTourOpen(false), [])
  const [theme, setTheme] = useState<Theme>(() => currentTheme())
  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    setTheme(next)
  }

  const abortRef = useRef<AbortController | null>(null)
  /** the live session (plan + running sums + cursor) so Stop can be resumed */
  const liveRef = useRef<{ stack: LiveStack; ra: number; dec: number } | null>(null)
  /** stable handle so selectCurated (declared first) can stop a running refinement */
  const stopLiveRef = useRef<() => void>(() => {})
  /** Increments on every user selection, so a slow response can't override a newer choice. */
  const selectionSeq = useRef(0)

  const selectCurated = useCallback(async (entry: TargetIndexEntry) => {
    stopLiveRef.current()
    const seq = ++selectionSeq.current
    setSelectedId(entry.id)
    setLoadingId(entry.id)
    setCuratedError(null)
    try {
      const data = await loadCuratedTarget(entry)
      if (seq !== selectionSeq.current) return
      const source: DataSource = { kind: 'curated', id: entry.id }
      setShown({ data, source, spectrum: { load: () => loadCuratedSpectrum(entry) } })
    } catch (e) {
      if (seq !== selectionSeq.current) return
      setCuratedError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingId((id) => (id === entry.id ? null : id))
    }
  }, [])

  // load the curated index once; auto-select from the hash or the first target
  useEffect(() => {
    let cancelled = false
    loadCuratedIndex()
      .then((targets) => {
        if (cancelled) return
        setIndex({ status: 'ok', targets })
        const src = initialUrl.source
        const wanted = src?.kind === 'curated' ? targets.find((t) => t.id === src.id) : undefined
        if (src?.kind === 'curated' && !wanted) setNotice((n) => [...n, `there is no curated target "${src.id}"`])
        const liveFromLink = src?.kind === 'custom' && !!API_URL
        const first = wanted ?? (liveFromLink ? undefined : targets.find((t) => t.n_epochs > 0) ?? targets[0])
        if (first) void selectCurated(first)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setIndex({
          status: 'error',
          missing: e instanceof StaticDataError && e.missing,
          message: e instanceof Error ? e.message : String(e),
        })
      })
    return () => {
      cancelled = true
    }
  }, [selectCurated, initialUrl])

  useEffect(() => {
    if (embed) return
    let cancelled = false
    void loadManifest().then((m) => !cancelled && setManifest(m))
    return () => {
      cancelled = true
    }
  }, [embed])

  // Live refinement. Fired from user actions (never from an effect) so StrictMode can't
  // double-fire it. GET the plan, then POST refine with the cursor until done; each
  // response is folded into the running sums and re-rendered. Equal depth across epochs is
  // guaranteed by the server (whole rounds only), so every intermediate frame blinks fairly.
  const runLive = useCallback(async (ra: number, dec: number, resume: boolean) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const seq = ++selectionSeq.current
    const startedAt = Date.now()
    const sleep = (ms: number) =>
      new Promise<void>((res) => {
        const t = window.setTimeout(res, ms)
        ctrl.signal.addEventListener('abort', () => (window.clearTimeout(t), res()), { once: true })
      })
    const progress = (st: LiveStack): LiveProgress => ({
      depth: st.depth,
      total: st.total,
      failed: describeFailures(st),
    })
    const show = (st: LiveStack) => {
      const data = st.toTargetData()
      // e.g. a very bright star: the first (D6/D5) rounds can be (almost) fully masked. Keep
      // the "fetching first frames" placeholder until EVERY epoch's stacked frame is at least
      // half valid, so the first blink isn't a near-blank. Give up waiting after one full
      // detector cycle (an epoch may genuinely have little usable data) or when done.
      const cycle = new Set(st.plan.refine.slots).size
      const usable = data.epochs.every((e) => e.frames.ALL && e.frames.ALL.flagged_fraction <= 0.5)
      if (!st.done && st.depth < cycle && !usable) return
      const result: Shown = { data, source: { kind: 'custom', ra, dec }, spectrum: { live: st.spectrumData() } }
      setCustomResult(result)
      if (seq === selectionSeq.current) {
        setShown(result)
        setSelectedId(null)
      }
    }
    const newStack = async () => {
      setCustomReq({ status: 'planning', ra, dec, startedAt })
      const plan = await fetchLivePlan(ra, dec, ctrl.signal)
      const st = new LiveStack(plan)
      liveRef.current = { stack: st, ra, dec }
      return st
    }

    try {
      const prev = liveRef.current
      let stack = resume && prev && prev.ra === ra && prev.dec === dec ? prev.stack : await newStack()
      if (ctrl.signal.aborted) return
      // first call small (1-2 per epoch) so frames show within seconds; then bigger batches
      let batch = stack.depth === 0 ? stack.plan.refine.first_batch : 6
      let errors = 0
      let restarts = 0
      if (stack.depth > 0) show(stack)
      setCustomReq({ status: 'refining', ra, dec, startedAt, progress: progress(stack) })

      while (!stack.done) {
        let res
        try {
          res = await refineLive({ ra, dec, cursor: stack.cursor, batch_per_epoch: batch }, ctrl.signal)
        } catch (e) {
          if (ctrl.signal.aborted) return
          const err = e instanceof ApiError ? e : new ApiError('server', e instanceof Error ? e.message : String(e))
          if (err.kind === 'plan-changed' && restarts++ < 2) {
            stack = await newStack()
            batch = stack.plan.refine.first_batch
            continue
          }
          // a failed batch keeps what we have; back off and retry a few times, then pause
          if (err.kind === 'invalid-input' || ++errors > 3) {
            setCustomReq(
              stack.depth > 0
                ? { status: 'stopped', ra, dec, progress: progress(stack), error: err }
                : { status: 'error', ra, dec, error: err },
            )
            return
          }
          setCustomReq({
            status: 'refining',
            ra,
            dec,
            startedAt,
            progress: progress(stack),
            retrying: `A batch failed (${err.message}) Retrying (${errors}/3)…`,
          })
          await sleep(1000 * 2 ** errors)
          continue
        }
        if (ctrl.signal.aborted) return
        errors = 0
        stack.add(res)
        batch = 6
        if (res.committed > 0 || stack.done) show(stack)
        setCustomReq({ status: 'refining', ra, dec, startedAt, progress: progress(stack) })
        // no round finished in this call (archive busy): don't hot-loop
        if (res.committed === 0) await sleep(1500)
      }
      show(stack)
      setCustomReq({ status: 'done', ra, dec, progress: progress(stack) })
    } catch (e) {
      // superseded or stopped (which aborted this one): the stopper already set the state
      if (abortRef.current !== ctrl || ctrl.signal.aborted) return
      const error = e instanceof ApiError ? e : new ApiError('server', e instanceof Error ? e.message : String(e))
      setCustomReq({ status: 'error', ra, dec, error })
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null
    }
  }, [])

  /** Stop refining (Stop button, picking another target, leaving). Keeps what we have. */
  const stopLive = useCallback(() => {
    const ctrl = abortRef.current
    if (!ctrl) return
    ctrl.abort()
    abortRef.current = null
    setCustomReq((r) => {
      if (r.status === 'refining' && liveRef.current) return { status: 'stopped', ra: r.ra, dec: r.dec, progress: r.progress }
      if (r.status === 'planning' || r.status === 'refining')
        return { status: 'error', ra: r.ra, dec: r.dec, error: new ApiError('aborted', 'Request cancelled.') }
      return r
    })
  }, [])
  useEffect(() => {
    stopLiveRef.current = stopLive
  }, [stopLive])

  // abort any in-flight refinement when the app unmounts or the page is left
  useEffect(() => {
    const onHide = () => abortRef.current?.abort()
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      abortRef.current?.abort()
    }
  }, [])

  // A link with custom coordinates starts its live query right away. Scheduled with a
  // timer that the cleanup cancels, so StrictMode's mount → unmount → mount runs it once.
  useEffect(() => {
    if (!initialCustom || !API_URL) return
    const t = window.setTimeout(() => void runLive(initialCustom.ra, initialCustom.dec, false), 0)
    return () => window.clearTimeout(t)
  }, [initialCustom, runLive])

  // State → URL. A new target or position pushes a history entry (so Back returns to the
  // previous one); detector / view / stretch tweaks and the landing URL only replace it.
  const shownSource = shown?.source ?? null
  const firstWrite = useRef(true)
  /** set while Back/Forward restores a view: the URL is already right, so don't write
   * (a write before the restored target arrives would push and wipe Forward history) */
  const restoringTo = useRef<DataSource | null>(null)
  useEffect(() => {
    if (!shownSource) return
    if (restoringTo.current) {
      if (!sameSource(restoringTo.current, shownSource)) return
      restoringTo.current = null
      return
    }
    const search = toSearch(shownSource, display, embed)
    const landing = firstWrite.current
    firstWrite.current = false
    if (search === window.location.search && !window.location.hash) return
    const current = readUrl(window.location).source
    const push = !landing && !!current && !sameSource(current, shownSource)
    const url = `${window.location.pathname}${search}`
    if (push) window.history.pushState(null, '', url)
    else window.history.replaceState(null, '', url)
  }, [shownSource, display, embed])

  // URL → state on Back / Forward.
  const latest = useRef({ index, customResult, shown })
  useEffect(() => {
    latest.current = { index, customResult, shown }
  })
  useEffect(() => {
    const onPop = () => {
      const { source, display: d } = readUrl(window.location)
      const { index: idx, customResult: cr, shown: sh } = latest.current
      restoringTo.current = null
      setDisplay(d)
      if (!source || sameSource(source, sh?.source ?? null)) return
      restoringTo.current = source
      if (source.kind === 'curated') {
        const entry = idx.status === 'ok' ? idx.targets.find((t) => t.id === source.id) : undefined
        setTab('curated')
        if (entry) void selectCurated(entry)
        else restoringTo.current = null
        return
      }
      setTab('custom')
      if (cr && sameSource(cr.source, source)) {
        stopLiveRef.current()
        selectionSeq.current++
        setShown(cr)
        setSelectedId(null)
      } else if (API_URL) {
        void runLive(source.ra, source.dec, true)
      } else {
        restoringTo.current = null
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [runLive, selectCurated])

  const showCurated = useCallback(() => {
    restoringTo.current = null
    setTab('curated')
    if (shown?.source.kind !== 'curated' && index.status === 'ok') {
      const first = index.targets.find((t) => t.n_epochs > 0) ?? index.targets[0]
      if (first) void selectCurated(first)
    }
  }, [index, selectCurated, shown])

  const customLoading = customReq.status === 'planning' || customReq.status === 'refining'
  /** a (partial or finished) custom result the user isn't looking at */
  const customReady =
    !!customResult && (customReq.status === 'done' || customReq.status === 'stopped') && shown !== customResult
  const liveProgress =
    shown?.source.kind === 'custom' && shown === customResult && 'progress' in customReq ? customReq.progress : null

  const showCustomResult = () => {
    restoringTo.current = null
    if (!customResult) return
    selectionSeq.current++
    setShown(customResult)
    setSelectedId(null)
  }

  /** Aladin Lite panel for the field on show; BlinkPlayer places it beside or under the canvas */
  const skyContext = shown && (
    <SkyContextPanel
      ra={shown.data.grid.center_ra}
      dec={shown.data.grid.center_dec}
      epoch={shown.data.grid.center_epoch}
      sideDeg={(shown.data.grid.size_px * shown.data.grid.pixel_scale_arcsec) / 3600}
      name={shown.data.target.name}
      pmra={shown.data.target.pmra}
      pmdec={shown.data.target.pmdec}
    />
  )

  if (embed) {
    const src = shownSource ?? initialUrl.source
    const full = `${window.location.pathname}${toSearch(src, display, false)}`
    let status: string | null = null
    if (!shown || shown.data.epochs.length === 0) {
      if (shown) status = 'No SPHEREx coverage here yet.'
      else if (initialCustom && !API_URL) status = 'Custom coordinates need the live API, which this site does not have.'
      else if (customReq.status === 'error') status = customReq.error.message
      else if (index.status === 'error') status = index.message
      else if (curatedError) status = curatedError
      else if (customLoading) status = 'Fetching SPHEREx frames…'
      else status = 'Loading…'
    }
    return (
      <div className="flex min-h-svh flex-col gap-2 bg-background p-2 text-foreground">
        {status ? (
          <div className="flex min-h-60 flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            {status.endsWith('…') && <Loader2 className="size-6 animate-spin" />}
            <p>{status}</p>
          </div>
        ) : (
          shown && (
            <BlinkPlayer
              key={`${shown.source.kind}:${shown.data.target.id}:${shown.data.generated_at}`}
              data={shown.data}
              display={display}
              onDisplayChange={setDisplay}
              embed
            />
          )
        )}
        {notice.length > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Part of this link couldn't be used ({notice.join('; ')}); showing defaults instead.
          </p>
        )}
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate">
            {shown?.data.target.name ?? ''}
            {liveProgress && customReq.status === 'refining' && ` · refining ${liveProgress.depth}/${liveProgress.total}`}
          </span>
          <a
            href={full}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 hover:text-foreground"
          >
            Open in Waveshift <ExternalLink className="size-3" />
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b border-border">
        <div className="flex items-center gap-3 px-4 py-3 lg:px-6">
          <Mark className="h-7 w-auto shrink-0" />
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-baseline gap-x-3">
              <span className="display masthead-name">Waveshift</span>
              <span className="text-sm font-medium text-muted-foreground">SPHEREx blink comparator</span>
            </h1>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1 self-center">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Replay the guided tour"
              title="Replay the guided tour"
              onClick={() => setTourOpen(true)}
            >
              <CircleHelp />
            </Button>
            <SourceLink />
          </div>
        </div>
      </header>

      <main className="lg:grid lg:grid-cols-[21rem_minmax(0,1fr)]">
        {/* --- picker: a rail down the left edge, not a floating card --- */}
        <aside className="border-b border-border bg-card lg:border-r lg:border-b-0">
          <div className="lg:sticky lg:top-0 lg:max-h-svh lg:overflow-y-auto">
            <div className="p-4 lg:p-5" data-tour="picker">
              <p className="mb-4 text-sm text-pretty text-muted-foreground">
                Flip between observation epochs. Stars stay put; nearby and moving objects jump.
              </p>
              <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
                <TabsList className="mb-4 w-full">
                  <TabsTrigger value="curated">Curated targets</TabsTrigger>
                  <TabsTrigger value="custom">
                    Custom RA/Dec
                    {customLoading && <Loader2 className="animate-spin" />}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="curated" className="flex flex-col gap-3">
                  {index.status === 'loading' && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" /> Loading targets…
                    </p>
                  )}
                  {index.status === 'error' && (
                    <Alert>
                      <SearchX />
                      <AlertTitle>{index.missing ? 'No curated targets found' : "Couldn't load curated targets"}</AlertTitle>
                      <AlertDescription>
                        {index.missing
                          ? 'The target list (data/targets.json) is missing from this site. Run `just build` to regenerate it. Custom coordinates still work if the API is up.'
                          : index.message}
                      </AlertDescription>
                    </Alert>
                  )}
                  {index.status === 'ok' && index.targets.length === 0 && (
                    <p className="text-sm text-muted-foreground">The curated list is empty.</p>
                  )}
                  {index.status === 'ok' && index.targets.length > 0 && (
                    <>
                      <p className="text-sm text-muted-foreground">
                        Pre-built from SPHEREx data. These load instantly.
                      </p>
                      <CuratedList
                        targets={index.targets}
                        selectedId={selectedId}
                        loadingId={loadingId}
                        onSelect={(t) => {
                          restoringTo.current = null
                          void selectCurated(t)
                        }}
                      />
                    </>
                  )}
                  {curatedError && (
                    <Alert variant="destructive">
                      <AlertTitle>Couldn't load that target</AlertTitle>
                      <AlertDescription>{curatedError}</AlertDescription>
                    </Alert>
                  )}
                </TabsContent>

                {/* forceMount keeps the form and request state alive when switching tabs */}
                <TabsContent value="custom" forceMount className="data-[state=inactive]:hidden">
                  <CustomPanel
                    request={customReq}
                    initialRa={initialCustom ? String(initialCustom.ra) : undefined}
                    initialDec={initialCustom ? String(initialCustom.dec) : undefined}
                    onSubmit={(ra, dec) => {
                      restoringTo.current = null
                      void runLive(ra, dec, false)
                    }}
                    onResume={(ra, dec) => void runLive(ra, dec, true)}
                    onCancel={stopLive}
                    onShowCurated={showCurated}
                  />
                  {customReady && (
                    <Button className="mt-3 w-full" variant="secondary" onClick={showCustomResult}>
                      Show result for {customResult.data.target.name}
                    </Button>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </aside>

        {/* --- viewer --- */}
        <section className="min-w-0 px-4 py-6 lg:px-8 lg:py-8">
          <div className="mx-auto max-w-[80rem]">
          {liveProgress && (
            <div
              role="status"
              aria-live="polite"
              className="mb-3 flex flex-col gap-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  {customReq.status === 'refining' && <Loader2 className="size-4 animate-spin" />}
                  {customReq.status === 'refining' ? 'refining' : customReq.status === 'done' ? 'complete' : 'stopped'} ·{' '}
                  <span className="font-mono tabular-nums">
                    {liveProgress.depth}/{liveProgress.total}
                  </span>{' '}
                  exposures per epoch
                </span>
                {customReq.status === 'refining' && (
                  <Button size="sm" variant="outline" onClick={stopLive}>
                    <Square /> Stop
                  </Button>
                )}
                {customReq.status === 'stopped' && (
                  <Button size="sm" variant="outline" onClick={() => void runLive(customReq.ra, customReq.dec, true)}>
                    Resume
                  </Button>
                )}
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${liveProgress.total ? (100 * liveProgress.depth) / liveProgress.total : 100}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Every epoch is always shown at the same depth, so the blink stays fair while it sharpens.
                {liveProgress.failed.length > 0 && <> Skipped: {liveProgress.failed.join('; ')}.</>}
              </p>
            </div>
          )}
          {customReady && (
            <div
              role="status"
              className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
            >
              <span>
                Your custom patch <strong>{customResult.data.target.name}</strong>{' '}
                {customReq.status === 'done' ? 'is ready' : 'was stopped part-way'}.
              </span>
              <Button size="sm" onClick={showCustomResult}>
                Show it
              </Button>
            </div>
          )}

          {notice.length > 0 && (
            <div
              role="status"
              className="mb-3 flex items-start justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
            >
              <span>
                Part of this link couldn't be used ({notice.join('; ')}); defaults are shown for that part.
              </span>
              <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() => setNotice([])}>
                <X />
              </Button>
            </div>
          )}
          {shown ? (
            <div>
              <TargetHeader shown={shown} />
              <div>
                {shown.data.epochs.length === 0 ? (
                  <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-6">
                    <p className="font-medium">No SPHEREx coverage here yet</p>
                    <p className="text-sm text-muted-foreground">
                      The archive has no images at this position so far. SPHEREx keeps scanning the whole sky, so try
                      again after a future data release, or pick a curated target.
                    </p>
                    <Button size="sm" onClick={showCurated}>
                      Explore curated targets
                    </Button>
                    <div className="w-full">{skyContext}</div>
                  </div>
                ) : (
                  <BlinkPlayer
                    key={`${shown.source.kind}:${shown.data.target.id}:${shown.data.generated_at}`}
                    data={shown.data}
                    display={display}
                    onDisplayChange={(d) => {
                      restoringTo.current = null // a user change always wins over an unfinished restore
                      setDisplay(d)
                    }}
                    spectrum={shown.spectrum}
                    aside={skyContext}
                  />
                )}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border text-center text-muted-foreground">
                {customLoading || loadingId ? (
                  <>
                    <Loader2 className="size-8 animate-spin" />
                    <p>{customLoading ? 'Fetching the first frames. See progress on the left.' : 'Loading…'}</p>
                  </>
                ) : (
                  <>
                    <Orbit className="size-10" />
                    <p>Pick a curated target or enter coordinates to start blinking.</p>
                  </>
                )}
              </div>
            </div>
          )}

          <p className="mt-8 max-w-[90ch] border-t border-border pt-4 text-xs text-muted-foreground">
            Images: NASA SPHEREx via IRSA, background-subtracted and stacked per epoch (median for curated targets, mean
            for live views). Orientation: north up,
            east left. A real mover shifts between epochs along the predicted track; artefacts and variable stars
            change brightness without moving.
          </p>
          {manifest && (
            <p className="mt-2 text-xs text-muted-foreground">
              Curated targets built{' '}
              {new Date(manifest.generated_at).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}{' '}
              ·{' '}
              {API_URL
                ? `Live views query IRSA at request time (collections: ${manifest.collections.join(', ')})`
                : 'Live views are not available on this site'}
            </p>
          )}
          </div>
        </section>
      </main>
      {/* the tour points at the player, so it waits until there is something to blink */}
      <Tour
        open={tourOpen && !!shown && shown.data.epochs.length > 1}
        onClose={closeTour}
        mode={display.mode}
        cycleMs={((shown?.data.epochs.length ?? 3) / 1.5) * 1000}
      />
    </div>
  )
}
