import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Orbit, SearchX, Square, TriangleAlert } from 'lucide-react'

import { BlinkPlayer } from '@/components/BlinkPlayer'
import { CuratedList } from '@/components/CuratedList'
import { CustomPanel, type CustomRequest, type LiveProgress } from '@/components/CustomPanel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ApiError, fetchLivePlan, loadCuratedIndex, loadCuratedTarget, refineLive, StaticDataError } from '@/lib/api'
import { describeFailures, LiveStack } from '@/lib/live'
import { coreSaturated, motionPxPerYear } from '@/lib/render'
import type { DataSource, TargetData, TargetIndexEntry } from '@/lib/types'

type IndexState =
  | { status: 'loading' }
  | { status: 'ok'; targets: TargetIndexEntry[] }
  | { status: 'error'; missing: boolean; message: string }

type Tab = 'curated' | 'custom'

interface Shown {
  data: TargetData
  source: DataSource
}

// --- URL hash: #target=<id>  or  #ra=<deg>&dec=<deg> ------------------------

function readHash(): { target?: string; ra?: string; dec?: string } {
  const p = new URLSearchParams(window.location.hash.slice(1))
  return { target: p.get('target') ?? undefined, ra: p.get('ra') ?? undefined, dec: p.get('dec') ?? undefined }
}

function writeHash(source: DataSource) {
  const p =
    source.kind === 'curated'
      ? new URLSearchParams({ target: source.id })
      : new URLSearchParams({ ra: String(source.ra), dec: String(source.dec) })
  window.history.replaceState(null, '', `#${p.toString()}`)
}

// --- helpers --------------------------------------------------------------------

function fmtCoord(v: number, signed = false): string {
  return `${signed && v >= 0 ? '+' : ''}${v.toFixed(4)}°`
}

function TargetHeader({ shown }: { shown: Shown }) {
  const { data, source } = shown
  const t = data.target
  const pxPerYr = motionPxPerYear(data)
  const years = data.epochs.length > 1 ? data.epochs[data.epochs.length - 1].year_mid - data.epochs[0].year_mid : 0
  const pmTotal = Math.hypot(t.pmra, t.pmdec)

  return (
    <CardHeader>
      <div className="flex flex-wrap items-center gap-2">
        <CardTitle className="text-xl">{t.name}</CardTitle>
        <Badge variant="secondary" className="capitalize">
          {t.kind}
        </Badge>
        {source.kind === 'custom' && <Badge variant="outline">live</Badge>}
      </div>
      <CardDescription className="flex flex-col gap-1">
        <span className="font-mono text-xs">
          RA {fmtCoord(data.grid.center_ra)} · Dec {fmtCoord(data.grid.center_dec, true)} (field centre,{' '}
          {data.grid.center_epoch}) · {data.grid.size_px}×{data.grid.size_px} px at {data.grid.pixel_scale_arcsec}″/px
        </span>
        {pmTotal > 0 ? (
          <span>
            Proper motion {(pmTotal / 1000).toFixed(2)}″/yr, about{' '}
            <strong className="text-foreground">{pxPerYr.toFixed(2)} px/yr</strong>
            {years > 0 && (
              <>
                {' '}
                → expect a shift of ~{(pxPerYr * years).toFixed(1)} px across these {data.epochs.length} epochs
              </>
            )}
            . The cyan reticle marks where it should be in each epoch.
          </span>
        ) : (
          <span>
            Custom position with no known proper motion: the reticle marks the field centre. Look for anything that
            shifts or changes brightness between epochs.
          </span>
        )}
        {coreSaturated(data) && (
          <span className="flex items-center gap-1.5 text-foreground">
            <TriangleAlert className="size-4 shrink-0 text-amber-500" />
            Core saturated in near-IR: brightness changes show in the surrounding glow.
          </span>
        )}
        <span className="text-xs">
          {data.n_used} of {data.n_images} images used · {data.collections.join(', ') || 'no collections'} · built{' '}
          {new Date(data.generated_at).toLocaleString()}
        </span>
      </CardDescription>
    </CardHeader>
  )
}

// --- app ------------------------------------------------------------------------

export default function App() {
  const [initialHash] = useState(readHash)
  const [tab, setTab] = useState<Tab>(initialHash.ra || initialHash.dec ? 'custom' : 'curated')
  const [index, setIndex] = useState<IndexState>({ status: 'loading' })
  const [shown, setShown] = useState<Shown | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [curatedError, setCuratedError] = useState<string | null>(null)
  const [customReq, setCustomReq] = useState<CustomRequest>({ status: 'idle' })
  const [customResult, setCustomResult] = useState<Shown | null>(null)

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
      setShown({ data, source })
      writeHash(source)
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
        const wanted = targets.find((t) => t.id === initialHash.target)
        const wantsCustom = !!(initialHash.ra || initialHash.dec)
        const first = wanted ?? (wantsCustom ? undefined : targets.find((t) => t.n_epochs > 0) ?? targets[0])
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
  }, [selectCurated, initialHash])

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
      const result: Shown = { data, source: { kind: 'custom', ra, dec } }
      setCustomResult(result)
      if (seq === selectionSeq.current) {
        setShown(result)
        setSelectedId(null)
        writeHash(result.source)
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

  const showCurated = useCallback(() => {
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
    if (!customResult) return
    selectionSeq.current++
    setShown(customResult)
    setSelectedId(null)
    writeHash(customResult.source)
  }

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4">
          <Orbit className="size-7 text-primary" />
          <div>
            <h1 className="text-lg leading-tight font-semibold">Planet X · SPHEREx Blink</h1>
            <p className="text-sm text-muted-foreground">
              Flip between observation epochs. Stars stay put; nearby and moving objects jump.
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[340px_1fr]">
        {/* --- picker --- */}
        <aside>
          <Card>
            <CardContent>
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
                        onSelect={(t) => void selectCurated(t)}
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
                    initialRa={initialHash.ra}
                    initialDec={initialHash.dec}
                    onSubmit={(ra, dec) => void runLive(ra, dec, false)}
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
            </CardContent>
          </Card>
        </aside>

        {/* --- viewer --- */}
        <section className="min-w-0">
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
              className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm"
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

          {shown ? (
            <Card>
              <TargetHeader shown={shown} />
              <CardContent>
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
                  </div>
                ) : (
                  <BlinkPlayer
                    key={`${shown.source.kind}:${shown.data.target.id}:${shown.data.generated_at}`}
                    data={shown.data}
                  />
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="flex min-h-80 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
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
              </CardContent>
            </Card>
          )}

          <p className="mt-4 text-xs text-muted-foreground">
            Images: NASA SPHEREx via IRSA, background-subtracted and median-stacked per epoch. Orientation: north up,
            east left. A real mover shifts between epochs along the predicted track; artefacts and variable stars
            change brightness without moving.
          </p>
        </section>
      </main>
    </div>
  )
}
