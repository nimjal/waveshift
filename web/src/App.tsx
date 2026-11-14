import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Orbit, SearchX } from 'lucide-react'

import { BlinkPlayer } from '@/components/BlinkPlayer'
import { CuratedList } from '@/components/CuratedList'
import { CustomPanel, type CustomRequest } from '@/components/CustomPanel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ApiError, fetchCustomTarget, loadCuratedIndex, loadCuratedTarget, StaticDataError } from '@/lib/api'
import { motionPxPerYear } from '@/lib/render'
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
  /** Increments on every user selection, so a slow response can't override a newer choice. */
  const selectionSeq = useRef(0)

  const selectCurated = useCallback(async (entry: TargetIndexEntry) => {
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

  // abort any in-flight custom request when the app unmounts
  useEffect(() => () => abortRef.current?.abort(), [])

  // Fired from the submit handler (never from an effect) so StrictMode can't double-fire
  // a multi-minute build.
  const submitCustom = useCallback(async (ra: number, dec: number) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const seq = ++selectionSeq.current
    setCustomReq({ status: 'loading', ra, dec, startedAt: Date.now() })
    try {
      const data = await fetchCustomTarget(ra, dec, ctrl.signal)
      if (ctrl.signal.aborted) return
      const result: Shown = { data, source: { kind: 'custom', ra, dec } }
      setCustomResult(result)
      setCustomReq({ status: 'done', ra, dec })
      // only take over the view if the user hasn't picked something else meanwhile
      if (seq === selectionSeq.current) {
        setShown(result)
        setSelectedId(null)
        writeHash(result.source)
      }
    } catch (e) {
      // superseded by a newer request (which aborted this one): stay quiet
      if (abortRef.current !== ctrl) return
      const error = e instanceof ApiError ? e : new ApiError('server', e instanceof Error ? e.message : String(e))
      setCustomReq({ status: 'error', ra, dec, error })
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null
    }
  }, [])

  const cancelCustom = useCallback(() => abortRef.current?.abort(), [])

  const showCurated = useCallback(() => {
    setTab('curated')
    if (shown?.source.kind !== 'curated' && index.status === 'ok') {
      const first = index.targets.find((t) => t.n_epochs > 0) ?? index.targets[0]
      if (first) void selectCurated(first)
    }
  }, [index, selectCurated, shown])

  const customLoading = customReq.status === 'loading'
  /** a finished custom result the user isn't looking at (they picked something else meanwhile) */
  const customReady = !!customResult && customReq.status === 'done' && shown !== customResult

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
                    onSubmit={(ra, dec) => void submitCustom(ra, dec)}
                    onCancel={cancelCustom}
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
          {customLoading && shown && (
            <p className="mb-3 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Building your custom patch in the background. Keep exploring; a notice will appear here when it's ready.
            </p>
          )}
          {customReady && (
            <div
              role="status"
              className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm"
            >
              <span>
                Your custom patch <strong>{customResult.data.target.name}</strong> is ready.
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
                    <p>{customLoading ? 'Building your sky patch. See progress on the left.' : 'Loading…'}</p>
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
