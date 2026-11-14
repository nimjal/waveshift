// Sky context: CDS Aladin Lite v3 (the CDS team's official `aladin-lite` npm build, pinned to
// the latest stable release and loaded from jsDelivr as an ES module) centred on the field,
// with the blink grid outlined. The URL in the Aladin README (aladin.cds.unistra.fr/AladinLite/
// api/v3/latest/aladin.js) returned 404 when this was written (Nov 2026). Collapsed by default and only loaded when opened, so it
// costs nothing on first paint; if the CDS script can't be reached the panel says so quietly
// and the rest of the app is unaffected.

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Globe } from 'lucide-react'

import { cn } from '@/lib/utils'

const SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js'
const LOAD_TIMEOUT_MS = 20000
// CDS HiPS CDS/P/2MASS/color and CDS/P/allWISE/color, served from IRSA's mirror of them (listed
// as hips_service_url_2 by the CDS MocServer). Given as URLs so Aladin skips its ID lookup: in
// Nov 2026 the CDS lookup hosts that aladin-lite 3.8.2 uses (alasky.unistra.fr, alaskybis) did
// not answer and alasky.cds.unistra.fr returned 404 for these surveys, while IRSA (CORS *) did.
const SURVEYS = [
  {
    id: 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color',
    label: '2MASS colour',
    note: 'near-infrared J, H, Ks (1.2–2.2 µm)',
  },
  {
    id: 'https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1',
    label: 'AllWISE colour',
    note: 'mid-infrared W1, W2, W4 (3.4–22 µm)',
  },
] as const
const OUTLINE = '#22d3ee' // same cyan as the player's reticle
const PREF_KEY = 'waveshift:sky-open'

// Minimal typing of the parts of the Aladin Lite API used here.
interface AladinOverlay {
  addFootprints(f: unknown[]): void
  removeAll(): void
}
interface AladinInstance {
  gotoRaDec(ra: number, dec: number): void
  setFoV(deg: number): void
  setBaseImageLayer(id: string): void
  addOverlay(o: AladinOverlay): void
}
interface AladinGlobal {
  init: Promise<void>
  aladin(el: HTMLElement, opts: Record<string, unknown>): AladinInstance
  graphicOverlay(opts: Record<string, unknown>): AladinOverlay
  polygon(vertices: [number, number][], opts?: Record<string, unknown>): unknown
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

/** Corners of a square of side `sideDeg` centred on (ra0, dec0), north up: exact gnomonic
 * (tangent-plane) inverse, so it stays square near the poles too. */
function fieldCorners(ra0: number, dec0: number, sideDeg: number): [number, number][] {
  const r = Math.PI / 180
  const h = (sideDeg / 2) * r
  const d0 = dec0 * r
  // tangent-plane offsets (xi east, eta north); listed NE, NW, SW, SE
  return (
    [
      [h, h],
      [-h, h],
      [-h, -h],
      [h, -h],
    ] as const
  ).map(([xi, eta]) => {
    const rho = Math.hypot(1, xi, eta)
    const dec = Math.asin((Math.sin(d0) + eta * Math.cos(d0)) / rho)
    const ra = ra0 * r + Math.atan2(xi, Math.cos(d0) - eta * Math.sin(d0))
    return [(((ra / r) % 360) + 360) % 360, dec / r] as [number, number]
  })
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

interface Props {
  ra: number
  dec: number
  /** side of the blink grid, degrees (size_px × pixel_scale) */
  sideDeg: number
  name: string
}

export function SkyContextPanel({ ra, dec, sideDeg, name }: Props) {
  const [open, setOpen] = useState(readPref)
  /** once opened, the viewer stays mounted (hidden when collapsed) so it isn't rebuilt */
  const [everOpened, setEverOpened] = useState(open)
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [survey, setSurvey] = useState<string>(SURVEYS[0].id)
  const holder = useRef<HTMLDivElement>(null)
  const inst = useRef<{ aladin: AladinInstance; overlay: AladinOverlay } | null>(null)
  const aladinRef = useRef<AladinGlobal | null>(null)
  const latest = useRef({ ra, dec, sideDeg, survey })
  useEffect(() => {
    latest.current = { ra, dec, sideDeg, survey }
  })

  // create the viewer the first time the panel is opened (once, even under StrictMode)
  useEffect(() => {
    if (!open || inst.current) return
    let cancelled = false
    setState('loading')
    loadAladin().then(
      (A) => {
        const el = holder.current
        if (cancelled || !el || inst.current) return
        const { ra: r, dec: d, sideDeg: side, survey: sv } = latest.current
        try {
          const aladin = A.aladin(el, {
            survey: sv,
            target: `${r} ${d}`,
            fov: side * 3,
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
            showFullscreenControl: true,
            showFrame: false,
            showStatusBar: false,
            log: false, // no usage ping to CDS
          })
          const overlay = A.graphicOverlay({ color: OUTLINE, lineWidth: 2 })
          aladin.addOverlay(overlay)
          overlay.addFootprints([A.polygon(fieldCorners(r, d, side), { closed: true })])
          inst.current = { aladin, overlay }
          aladinRef.current = A
          setState('ready')
        } catch {
          setState('failed')
        }
      },
      () => !cancelled && setState('failed'),
    )
    return () => {
      cancelled = true
    }
  }, [open])

  // follow the target
  useEffect(() => {
    const v = inst.current
    const A = aladinRef.current
    if (!v || !A) return
    v.aladin.gotoRaDec(ra, dec)
    v.aladin.setFoV(sideDeg * 3)
    v.overlay.removeAll()
    v.overlay.addFootprints([A.polygon(fieldCorners(ra, dec, sideDeg), { closed: true })])
  }, [ra, dec, sideDeg, state])

  useEffect(() => {
    if (state === 'ready') inst.current?.aladin.setBaseImageLayer(survey)
  }, [survey, state])

  const toggle = () => {
    const next = !open
    writePref(next)
    setOpen(next)
    if (next) setEverOpened(true)
  }
  const arcmin = sideDeg * 60

  return (
    <section className="rounded-md border border-border bg-card" aria-label="Sky context">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">Sky context</span>
        <span className="truncate text-xs text-muted-foreground">Aladin Lite · {arcmin.toFixed(2)}′ field outlined</span>
        <ChevronDown className={cn('ml-auto size-4 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {everOpened && (
        <div className={cn('flex flex-col gap-2 border-t border-border p-3', !open && 'hidden')}>
          <div className="relative w-full overflow-hidden rounded-md bg-black">
            {/* explicit height: Aladin makes its container position:relative, so inset-0 can't size it */}
            <div ref={holder} className="h-[320px] w-full sm:h-[400px]" aria-label={`Sky survey image around ${name}`} />
            {state !== 'ready' && (
              <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground">
                {state === 'failed'
                  ? "Sky context is unavailable right now (couldn't load Aladin Lite, or this browser lacks WebGL2)."
                  : 'Loading Aladin Lite…'}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <div className="flex gap-1" role="group" aria-label="Survey">
              {SURVEYS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={survey === s.id}
                  onClick={() => setSurvey(s.id)}
                  className={cn(
                    'cursor-pointer rounded border px-2 py-0.5',
                    survey === s.id ? 'border-primary text-foreground' : 'border-border hover:bg-muted',
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <span>{SURVEYS.find((s) => s.id === survey)?.note}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            The cyan square is the {arcmin.toFixed(2)}′ blink field, north up, east left. Viewer: CDS Aladin Lite (from jsDelivr).
            Imagery: the CDS 2MASS / AllWISE colour HiPS, served by IRSA's mirror.
          </p>
        </div>
      )}
    </section>
  )
}
