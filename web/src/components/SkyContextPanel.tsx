// Sky context: the same patch of sky in other surveys, in CDS Aladin Lite v3, with the blink
// field outlined, the target marked and Gaia DR3 sources overlaid.
//
// Where things come from (all fetched by the browser, only once the panel is open):
//   - viewer: the CDS team's official `aladin-lite` build (GPL-3), pinned, from jsDelivr. The
//     CDS copy (aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js) returned 404 in
//     Nov 2026. It is loaded at run time and never bundled into this repo.
//   - imagery: CDS HiPS (2MASS, AllWISE, DSS2 colour) from IRSA's mirror, for the same reason.
//   - Gaia DR3: VizieR I/355/gaiadr3, see fetchGaiaSources in lib/api.ts.
// If any of them can't be reached the panel says so and the rest of the app is unaffected.
//
// Layout: at >= 1280 px the panel sits beside the blink canvas, same size, always open. Below
// that it is a collapsible bar under the canvas, collapsed by default.

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Globe } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { fetchGaiaSources, GAIA_MAG_LIMIT, GAIA_MAX_SOURCES, type GaiaSource } from '@/lib/api'
import { cn } from '@/lib/utils'

const SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js'
const LOAD_TIMEOUT_MS = 20000
/** Surveys are given as URLs so Aladin skips its ID lookup on the CDS hosts. */
const SURVEYS = [
  {
    id: 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color',
    label: '2MASS',
    note: 'near-infrared J, H, Ks (1.2–2.2 µm), observed 1997–2001',
  },
  {
    id: 'https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1',
    label: 'AllWISE',
    note: 'mid-infrared W1, W2, W4 (3.4–22 µm), observed 2010',
  },
  {
    id: 'https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color',
    label: 'DSS colour',
    note: 'visible light, photographic plates, 1980s–1990s',
  },
] as const
const FOV_DEG = 5 / 60
/** Gaia query box, arcmin: a little more than the view, so panning a bit still shows sources. */
const GAIA_BOX_ARCMIN = 6
const GAIA_EPOCH = 2016.0
const WIDE_QUERY = '(min-width: 1280px)' // Tailwind's xl: keep in step with the xl: classes below
const OUTLINE = '#22d3ee' // same cyan as the player's reticle
const GAIA_COLOR = '#fbbf24' // amber-400
const PREF_KEY = 'waveshift:sky-open'
const MAS_PER_DEG = 3.6e6

// Minimal typing of the parts of the Aladin Lite API used here.
interface AladinOverlay {
  add(shape: unknown): void
  removeAll(): void
}
interface AladinCatalog {
  addSources(sources: unknown[]): void
  removeAll(): void
  show(): void
  hide(): void
}
interface AladinInstance {
  gotoRaDec(ra: number, dec: number): void
  setFoV(deg: number): void
  setBaseImageLayer(id: string): void
  addOverlay(o: AladinOverlay): void
  addCatalog(c: AladinCatalog): void
  on(event: 'objectClicked', cb: (obj: { data?: unknown } | null) => void): void
}
interface AladinGlobal {
  init: Promise<void>
  aladin(el: HTMLElement, opts: Record<string, unknown>): AladinInstance
  graphicOverlay(opts: Record<string, unknown>): AladinOverlay
  polygon(vertices: [number, number][], opts?: Record<string, unknown>): unknown
  polyline(vertices: [number, number][], opts?: Record<string, unknown>): unknown
  circle(ra: number, dec: number, radiusDeg: number, opts?: Record<string, unknown>): unknown
  catalog(opts: Record<string, unknown>): AladinCatalog
  source(ra: number, dec: number, data: unknown): unknown
}

let loading: Promise<AladinGlobal> | null = null

/** Import the module once per page; rejects on network error, no WebGL2, or timeout. */
function loadAladin(): Promise<AladinGlobal> {
  if (loading) return loading
  const timeout = new Promise<never>((_, reject) =>
    window.setTimeout(() => reject(new Error('timeout')), LOAD_TIMEOUT_MS),
  )
  loading = Promise.race([
    (async () => {
      const mod = (await import(/* @vite-ignore */ SCRIPT_URL)) as { default: AladinGlobal }
      await mod.default.init // throws when the browser has no WebGL2
      return mod.default
    })(),
    timeout,
  ]).catch((e: unknown) => {
    loading = null // allow a retry on the next open
    throw e
  })
  return loading
}

// One viewer per page. BlinkPlayer is re-keyed for every target and this panel is mounted
// inside it, so the panel remounts on a target change. Aladin owns a WebGL context and has no
// destroy call, so the viewer lives in its own <div> that each mount adopts and re-centres.
interface Viewer {
  el: HTMLDivElement
  A: AladinGlobal
  aladin: AladinInstance
  /** field outline, target marker, track back to the Gaia epoch */
  overlay: AladinOverlay
  gaia: AladinCatalog
  /** the mounted panel's handler for a click on a Gaia source */
  onPick: (s: GaiaSource | null) => void
}
let viewer: Viewer | null = null
/** survey and Gaia switch survive the remount on a target change */
const session = { survey: SURVEYS[0].id as string, gaia: true }

function createViewer(A: AladinGlobal, holder: HTMLElement, ra: number, dec: number): Viewer {
  const el = document.createElement('div')
  el.style.cssText = 'width:100%;height:100%'
  holder.appendChild(el)
  const aladin = A.aladin(el, {
    survey: session.survey,
    target: `${ra} ${dec}`,
    fov: FOV_DEG,
    cooFrame: 'ICRSd',
    projection: 'TAN',
    showReticle: false,
    showContextMenu: false,
    showLayersControl: false,
    showProjectionControl: false,
    showSettingsControl: false,
    showShareControl: false,
    showSimbadPointerControl: false,
    showCooGridControl: false,
    showFullscreenControl: false,
    showZoomControl: true,
    showFrame: false,
    showStatusBar: false,
    showCooLocation: false,
    showFov: false,
    log: false, // no usage ping to CDS
  })
  const overlay = A.graphicOverlay({ color: OUTLINE, lineWidth: 2 })
  aladin.addOverlay(overlay)
  const gaia = A.catalog({ name: 'Gaia DR3', color: GAIA_COLOR, sourceSize: 12, shape: 'circle' })
  aladin.addCatalog(gaia)
  const v: Viewer = { el, A, aladin, overlay, gaia, onPick: () => {} }
  aladin.on('objectClicked', (obj) => {
    const d = obj?.data as GaiaSource | undefined
    v.onPick(d && typeof d.id === 'string' ? d : null)
  })
  return v
}

/** (ra, dec) moved by tangent-plane offsets (xi east, eta north), all in degrees: exact
 * gnomonic inverse, so the field stays square near the poles too. */
function offset(ra0: number, dec0: number, xiDeg: number, etaDeg: number): [number, number] {
  const r = Math.PI / 180
  const xi = xiDeg * r
  const eta = etaDeg * r
  const d0 = dec0 * r
  const rho = Math.hypot(1, xi, eta)
  const dec = Math.asin((Math.sin(d0) + eta * Math.cos(d0)) / rho)
  const ra = ra0 * r + Math.atan2(xi, Math.cos(d0) - eta * Math.sin(d0))
  return [(((ra / r) % 360) + 360) % 360, dec / r]
}

/** Corners of the blink field (north up), listed NE, NW, SW, SE. */
function fieldCorners(ra0: number, dec0: number, sideDeg: number): [number, number][] {
  const h = sideDeg / 2
  return [offset(ra0, dec0, h, h), offset(ra0, dec0, -h, h), offset(ra0, dec0, -h, -h), offset(ra0, dec0, h, -h)]
}

function fmtAngle(arcsec: number): string {
  return arcsec < 60 ? `${arcsec.toFixed(0)}″` : `${(arcsec / 60).toFixed(1)}′`
}

function readPref(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) === '1'
  } catch {
    return false
  }
}
function writePref(open: boolean) {
  try {
    window.localStorage.setItem(PREF_KEY, open ? '1' : '0')
  } catch {
    // storage blocked: the panel just starts collapsed next time
  }
}

/** True on screens wide enough for the panel to sit beside the canvas. */
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY)
    const onChange = () => setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return wide
}

interface Props {
  /** field centre = the target's position at `epoch`, degrees */
  ra: number
  dec: number
  /** decimal year of that position (grid.center_epoch) */
  epoch: number
  /** side of the blink grid, degrees (size_px × pixel_scale) */
  sideDeg: number
  name: string
  /** catalogue proper motion, mas/yr (pmra includes cos dec); 0 for custom positions */
  pmra: number
  pmdec: number
}

/** outcome of the Gaia query for the field `field` (see fieldKey) */
type GaiaResult = { field: string } & ({ status: 'failed' } | { status: 'ok'; count: number })

export function SkyContextPanel({ ra, dec, epoch, sideDeg, name, pmra, pmdec }: Props) {
  const wide = useWide()
  const [userOpen, setUserOpen] = useState(readPref)
  const open = wide || userOpen
  /** once opened, the viewer stays mounted (hidden when collapsed) so it isn't rebuilt */
  const [everOpened, setEverOpened] = useState(open)
  if (open && !everOpened) setEverOpened(true)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(viewer ? 'ready' : 'loading')
  const [survey, setSurvey] = useState(session.survey)
  const [gaiaOn, setGaiaOn] = useState(session.gaia)
  const [gaiaResult, setGaiaResult] = useState<GaiaResult | null>(null)
  const [pickedSource, setPicked] = useState<GaiaSource | null>(null)
  const holder = useRef<HTMLDivElement>(null)
  const latest = useRef({ ra, dec })
  useEffect(() => {
    latest.current = { ra, dec }
  })

  // Where the target was at the Gaia epoch, when it has a proper motion worth drawing.
  const dt = GAIA_EPOCH - epoch
  const backArcsec = (Math.hypot(pmra, pmdec) * Math.abs(dt)) / 1000
  const hasTrack = backArcsec >= 2

  // adopt the page's viewer, or create it the first time the panel is opened
  useEffect(() => {
    const el = holder.current
    if (!everOpened || !el) return
    let cancelled = false
    const adopt = (v: Viewer) => {
      if (v.el.parentElement !== el) el.appendChild(v.el)
      v.onPick = setPicked
      setState('ready')
    }
    if (viewer) adopt(viewer)
    else
      loadAladin().then(
        (A) => {
          if (cancelled) return
          try {
            viewer ??= createViewer(A, el, latest.current.ra, latest.current.dec)
            adopt(viewer)
          } catch {
            setState('failed')
          }
        },
        () => !cancelled && setState('failed'),
      )
    return () => {
      cancelled = true
      if (viewer && viewer.el.parentElement === el) {
        viewer.onPick = () => {}
        viewer.el.remove() // parked until the next mount adopts it
      }
    }
  }, [everOpened])

  // follow the target: centre, field outline, target marker, track back to the Gaia epoch
  useEffect(() => {
    const v = viewer
    if (state !== 'ready' || !v) return
    v.aladin.gotoRaDec(ra, dec)
    v.aladin.setFoV(FOV_DEG)
    v.overlay.removeAll()
    v.overlay.add(v.A.polygon(fieldCorners(ra, dec, sideDeg), { closed: true }))
    v.overlay.add(v.A.circle(ra, dec, 8 / 3600, { color: OUTLINE, lineWidth: 2 }))
    if (hasTrack) {
      const then = offset(ra, dec, (pmra * dt) / MAS_PER_DEG, (pmdec * dt) / MAS_PER_DEG)
      v.overlay.add(v.A.polyline([[ra, dec], then], { color: OUTLINE, lineWidth: 1 }))
    }
  }, [ra, dec, sideDeg, pmra, pmdec, dt, hasTrack, state])

  useEffect(() => {
    session.survey = survey
    if (state === 'ready') viewer?.aladin.setBaseImageLayer(survey)
  }, [survey, state])

  // Gaia DR3 layer
  useEffect(() => {
    session.gaia = gaiaOn
    const v = viewer
    if (state !== 'ready' || !v) return
    v.gaia.removeAll()
    if (!gaiaOn) {
      v.gaia.hide()
      return
    }
    const ctrl = new AbortController()
    const field = `${ra},${dec}`
    fetchGaiaSources(ra, dec, GAIA_BOX_ARCMIN, ctrl.signal).then(
      (sources) => {
        if (ctrl.signal.aborted) return
        v.gaia.addSources(sources.map((s) => v.A.source(s.ra, s.dec, s)))
        v.gaia.show()
        setPicked(null)
        setGaiaResult({ field, status: 'ok', count: sources.length })
      },
      () => !ctrl.signal.aborted && setGaiaResult({ field, status: 'failed' }),
    )
    return () => ctrl.abort()
  }, [ra, dec, gaiaOn, state])

  // what the Gaia line says: off, still loading (no result for this field yet), or the result
  const gaia: { status: 'off' | 'loading' } | GaiaResult = !gaiaOn
    ? { status: 'off' }
    : gaiaResult?.field === `${ra},${dec}`
      ? gaiaResult
      : { status: 'loading' }
  const picked = gaia.status === 'ok' ? pickedSource : null

  const toggle = () => {
    writePref(!userOpen)
    setUserOpen(!userOpen)
  }
  const arcmin = sideDeg * 60
  const surveyInfo = SURVEYS.find((s) => s.id === survey) ?? SURVEYS[0]
  const pm = (v: number | null) => (v === null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`)

  return (
    <section className="rounded-md border border-border bg-card xl:border-0 xl:bg-transparent" aria-label="Sky context">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm xl:hidden"
      >
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">Sky context</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">2MASS, AllWISE, DSS · Gaia DR3</span>
        <ChevronDown className={cn('ml-auto size-4 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {everOpened && (
        <div className={cn('flex flex-col gap-2 border-t border-border p-3 xl:border-0 xl:p-0', !open && 'hidden')}>
          <div className="relative mx-auto aspect-square w-full max-w-[500px] overflow-hidden rounded-md border border-border bg-black">
            <div ref={holder} className="size-full" aria-label={`${surveyInfo.label} image of the sky around ${name}`} />
            {state === 'ready' ? (
              <div className="pointer-events-none absolute top-2 left-2 rounded bg-black/60 px-2 py-1 font-mono text-sm text-white">
                Sky context · {surveyInfo.label}
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground">
                {state === 'failed'
                  ? "Sky context is unavailable right now (couldn't load Aladin Lite, or this browser lacks WebGL2)."
                  : 'Loading Aladin Lite…'}
              </div>
            )}
          </div>

          <div className="mx-auto flex w-full max-w-[500px] flex-col gap-2 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="flex gap-1" role="group" aria-label="Survey">
                {SURVEYS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={survey === s.id}
                    onClick={() => setSurvey(s.id)}
                    className={cn(
                      'cursor-pointer rounded border px-2 py-1',
                      survey === s.id ? 'border-primary text-foreground' : 'border-border hover:bg-muted',
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Switch id="sky-gaia" checked={gaiaOn} onCheckedChange={setGaiaOn} />
                <Label htmlFor="sky-gaia" className="text-xs font-normal">
                  Gaia DR3
                </Label>
              </div>
            </div>
            <p>
              {surveyInfo.label}: {surveyInfo.note}.
              {gaia.status === 'loading' && ' Loading Gaia sources…'}
              {gaia.status === 'failed' && ' Gaia sources could not be loaded (VizieR did not answer).'}
              {gaia.status === 'ok' &&
                (gaia.count === 0
                  ? ` No Gaia source brighter than G ${GAIA_MAG_LIMIT} here.`
                  : ` ${gaia.count}${gaia.count >= GAIA_MAX_SOURCES ? ' brightest' : ''} Gaia sources with G < ${GAIA_MAG_LIMIT} (amber circles): click one for details.`)}
            </p>
            {picked && (
              <p className="rounded bg-muted/40 px-2 py-1 font-mono text-foreground" aria-live="polite">
                Gaia DR3 <span className="break-all">{picked.id}</span>
                {Number.isFinite(picked.gmag) && <> · G {picked.gmag.toFixed(2)}</>} · proper motion{' '}
                {picked.pmra === null || picked.pmdec === null ? 'not measured' : `${pm(picked.pmra)}, ${pm(picked.pmdec)} mas/yr (RA, Dec)`}
              </p>
            )}
            <p>
              The same patch of sky at higher resolution, as other surveys saw it years to decades ago. The cyan square
              is the {arcmin.toFixed(2)}′ blink field (north up, east left) and the cyan circle is where the target is
              in {epoch.toFixed(1)}. Gaia positions are for epoch {GAIA_EPOCH.toFixed(1)}, so fast movers appear
              offset.
              {hasTrack &&
                ` ${name} moves ${(Math.hypot(pmra, pmdec) / 1000).toFixed(2)}″ a year: the line runs ${fmtAngle(backArcsec)} back to where it was in ${GAIA_EPOCH.toFixed(1)}, and in the older images it is further back along the same direction.`}
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
