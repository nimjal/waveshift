// Every network call the app makes lives in this module:
//   - curated targets: static JSON under <base>/data/
//   - custom coordinates: the backend API, GET {VITE_API_URL}/target?ra=&dec= (plan)
//     then POST {VITE_API_URL}/target/refine until done (see lib/live.ts)

import { type LivePlan, looksLikePlan, looksLikeRefine, type RefineResponse } from './live'
import type { Lightcurve, SpectrumData, TargetData, TargetIndexEntry } from './types'

// ---------------------------------------------------------------------------
// Config

const DATA_BASE = `${import.meta.env.BASE_URL}data/`

function resolveApiUrl(): string | null {
  const fromEnv = (import.meta.env.VITE_API_URL as string | undefined)?.trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  // In dev, fall back to the local server started by `just api`.
  if (import.meta.env.DEV) return 'http://localhost:7860'
  return null
}

/** Base URL of the backend API, or null when this build has none configured. */
export const API_URL = resolveApiUrl()

// ---------------------------------------------------------------------------
// Errors

export type ApiErrorKind =
  | 'not-configured' // no VITE_API_URL in this build
  | 'invalid-input' // coordinates out of range (client or server 422)
  | 'network' // server unreachable, CORS, connection dropped
  | 'timeout' // gateway/proxy gave up (502/503/504 without our detail)
  | 'upstream' // the API reached the archive but it failed (502 with detail)
  | 'server' // any other non-OK response
  | 'bad-response' // response was not the expected JSON
  | 'plan-changed' // 409 from refine: the archive changed, restart from GET /target
  | 'aborted' // user cancelled

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  readonly detail?: string

  constructor(kind: ApiErrorKind, message: string, opts: { status?: number; detail?: string } = {}) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = opts.status
    this.detail = opts.detail
  }
}

export class StaticDataError extends Error {
  readonly missing: boolean

  constructor(message: string, missing: boolean) {
    super(message)
    this.name = 'StaticDataError'
    this.missing = missing
  }
}

// ---------------------------------------------------------------------------
// Validation (mirrors the API: ra in [0, 360), dec in [-90, 90])

export function validateCoords(ra: number, dec: number): string | null {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return 'RA and Dec must be numbers.'
  if (ra < 0 || ra >= 360) return 'RA must be between 0 and 360 degrees (360 excluded).'
  if (dec < -90 || dec > 90) return 'Dec must be between −90 and +90 degrees.'
  return null
}

function looksLikeTargetData(x: unknown): x is TargetData {
  if (!x || typeof x !== 'object') return false
  const d = x as Partial<TargetData>
  return (
    !!d.target &&
    !!d.grid &&
    typeof d.grid.size_px === 'number' &&
    Array.isArray(d.epochs)
  )
}

// ---------------------------------------------------------------------------
// Static curated data

/**
 * Fetch JSON from the static data dir. Dev servers and SPA hosts often answer a
 * missing file with index.html + 200, so check the content type and the parse.
 */
async function fetchStaticJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(DATA_BASE + path, { headers: { Accept: 'application/json' }, signal })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new StaticDataError(`Could not load ${path} (network error).`, false)
  }
  const type = res.headers.get('content-type') ?? ''
  if (res.status === 404 || (res.ok && type.includes('text/html'))) {
    throw new StaticDataError(`${path} was not found.`, true)
  }
  if (!res.ok) throw new StaticDataError(`Could not load ${path} (HTTP ${res.status}).`, false)
  try {
    return await res.json()
  } catch {
    throw new StaticDataError(`${path} is not valid JSON.`, false)
  }
}

let indexPromise: Promise<TargetIndexEntry[]> | null = null
const targetCache = new Map<string, Promise<TargetData>>()

/** The curated target list (targets.json). Cached for the page lifetime. */
export function loadCuratedIndex(): Promise<TargetIndexEntry[]> {
  indexPromise ??= fetchStaticJson('targets.json').then((data) => {
    if (!Array.isArray(data)) throw new StaticDataError('targets.json is not a list.', false)
    return data as TargetIndexEntry[]
  })
  // Don't cache failures, so a retry can succeed.
  indexPromise.catch(() => {
    indexPromise = null
  })
  return indexPromise
}

/** One curated target's data file. Cached, so switching back is instant. */
export function loadCuratedTarget(entry: TargetIndexEntry): Promise<TargetData> {
  const cached = targetCache.get(entry.id)
  if (cached) return cached
  const p = fetchStaticJson(entry.file).then((data) => {
    if (!looksLikeTargetData(data)) throw new StaticDataError(`${entry.file} has an unexpected shape.`, false)
    return data
  })
  targetCache.set(entry.id, p)
  p.catch(() => targetCache.delete(entry.id))
  return p
}

export interface Manifest {
  /** when the curated targets were last built (ISO 8601) */
  generated_at: string
  /** IRSA SIA collections queried (py/config/sources.toml); the live API uses the same config */
  collections: string[]
}

/** manifest.json: build date + collections, for the data-freshness line. null if missing. */
export async function loadManifest(): Promise<Manifest | null> {
  try {
    const m = (await fetchStaticJson('manifest.json')) as Partial<Manifest> | null
    if (!m || typeof m.generated_at !== 'string' || !Array.isArray(m.collections)) return null
    return { generated_at: m.generated_at, collections: m.collections }
  } catch {
    return null
  }
}

/** Warm the cache for a curated target without waiting on it (e.g. on hover). */
export function prefetchCuratedTarget(entry: TargetIndexEntry): void {
  loadCuratedTarget(entry).catch(() => {})
}

// ---------------------------------------------------------------------------
// Live API

/** GET /health. Resolves true if the API answers, false otherwise. Never throws. */
export async function checkApiHealth(signal?: AbortSignal): Promise<boolean> {
  if (!API_URL) return false
  try {
    const res = await fetch(`${API_URL}/health`, { signal })
    if (!res.ok) return false
    const body = (await res.json()) as { status?: string }
    return body.status === 'ok'
  } catch {
    return false
  }
}

function extractDetail(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const detail = (body as { detail?: unknown }).detail
  if (typeof detail === 'string') return detail
  // FastAPI 422: detail = [{ loc, msg, type }, ...]
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : ''))
      .filter(Boolean)
      .join('; ')
  }
  return undefined
}

/** Shared fetch + error mapping for the live API. Resolves the parsed JSON body. */
async function apiJson(path: string, init: RequestInit, signal?: AbortSignal): Promise<{ body: unknown; status: number }> {
  if (!API_URL) {
    throw new ApiError('not-configured', 'This site was built without a backend API, so custom coordinates are unavailable.')
  }
  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, signal, headers: { Accept: 'application/json', ...init.headers } })
  } catch (e) {
    if (signal?.aborted) throw new ApiError('aborted', 'Request cancelled.')
    throw new ApiError('network', `Couldn't reach the API at ${API_URL}.`, { detail: e instanceof Error ? e.message : undefined })
  }

  let body: unknown = undefined
  try {
    body = await res.json()
  } catch {
    if (signal?.aborted) throw new ApiError('aborted', 'Request cancelled.')
    // non-JSON body: proxies and gateways return HTML error pages
  }

  if (!res.ok) {
    const detail = extractDetail(body)
    if (res.status === 422) {
      throw new ApiError('invalid-input', 'The API rejected those coordinates.', { status: res.status, detail })
    }
    if (res.status === 409) {
      throw new ApiError('plan-changed', 'The archive changed since this patch was planned.', { status: res.status, detail })
    }
    if (res.status === 502 && detail) {
      throw new ApiError('upstream', 'The SPHEREx archive request failed.', { status: res.status, detail })
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new ApiError('timeout', 'The server took too long or is temporarily unavailable.', { status: res.status, detail })
    }
    throw new ApiError('server', `The API returned an error (HTTP ${res.status}).`, { status: res.status, detail })
  }
  return { body, status: res.status }
}

/**
 * GET /target: the refinement plan for a position (epochs + ordered exposures, no
 * pixels). One archive query, a few seconds; repeated positions are cached server-side.
 */
export async function fetchLivePlan(ra: number, dec: number, signal?: AbortSignal): Promise<LivePlan> {
  const invalid = validateCoords(ra, dec)
  if (invalid) throw new ApiError('invalid-input', invalid)
  const { body, status } = await apiJson(
    `/target?ra=${encodeURIComponent(ra)}&dec=${encodeURIComponent(dec)}`,
    { method: 'GET' },
    signal,
  )
  if (!looksLikePlan(body)) {
    throw new ApiError('bad-response', 'The API returned data in an unexpected format.', { status })
  }
  return body
}

/** POST /target/refine: the next batch for every epoch. Takes up to ~15 s. */
export async function refineLive(
  req: { ra: number; dec: number; cursor: string; batch_per_epoch: number },
  signal?: AbortSignal,
): Promise<RefineResponse> {
  const { body, status } = await apiJson(
    '/target/refine',
    { method: 'POST', body: JSON.stringify(req), headers: { 'Content-Type': 'application/json' } },
    signal,
  )
  if (!looksLikeRefine(body)) {
    throw new ApiError('bad-response', 'The API returned data in an unexpected format.', { status })
  }
  return body
}

/**
 * POST /photometry: the light curve of frames we already hold (a live view's mean stack).
 * /target/refine only returns per-call deltas, so the server can't measure the full stack
 * itself; we send it. Detectors D1-D6 only (photometry skips ALL).
 */
export async function fetchLightcurve(data: TargetData, signal?: AbortSignal): Promise<Lightcurve> {
  const epochs = data.epochs.map((e) => ({
    id: e.id,
    mjd_start: e.mjd_start,
    mjd_end: e.mjd_end,
    predicted_px: e.predicted_px,
    frames: Object.fromEntries(
      Object.entries(e.frames)
        .filter(([k]) => /^D[1-6]$/.test(k))
        .map(([k, f]) => [k, f.reasons ? { pixels: f.pixels, reasons: f.reasons } : { pixels: f.pixels }]),
    ),
  }))
  const { body, status } = await apiJson(
    '/photometry',
    {
      method: 'POST',
      body: JSON.stringify({ pixel_scale_arcsec: data.grid.pixel_scale_arcsec, epochs }),
      headers: { 'Content-Type': 'application/json' },
    },
    signal,
  )
  const lc = body as Partial<Lightcurve> | null
  if (!lc || typeof lc !== 'object' || !lc.detectors || typeof lc.detectors !== 'object') {
    throw new ApiError('bad-response', 'The API returned data in an unexpected format.', { status })
  }
  return lc as Lightcurve
}

/** GET /resolve: an object name resolved server-side (curated aliases, then CDS Sesame). */
export interface ResolvedName {
  query: string
  name: string
  source: string
  curated_id: string | null
  /** J2000 */
  ra: number
  dec: number
  pmra: number
  pmdec: number
  /** position moved by proper motion to the grid epoch: what a live query should use */
  epoch: number
  ra_epoch: number
  dec_epoch: number
}

/** Resolve an object name. null = not found (a normal answer, not an error). */
export async function resolveName(name: string, signal?: AbortSignal): Promise<ResolvedName | null> {
  try {
    const { body, status } = await apiJson(`/resolve?name=${encodeURIComponent(name)}`, { method: 'GET' }, signal)
    const r = body as Partial<ResolvedName> | undefined
    if (!r || typeof r.ra_epoch !== 'number' || typeof r.dec_epoch !== 'number') {
      throw new ApiError('bad-response', 'The name resolver returned data in an unexpected format.', { status })
    }
    return r as ResolvedName
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

const spectrumCache = new Map<string, Promise<SpectrumData | null>>()

/** A curated target's per-exposure spectrum samples (targets/<id>.spectrum.json, a few MB,
 * fetched on the first spectrum request only). null if this build has no sidecar. */
export function loadCuratedSpectrum(entry: TargetIndexEntry): Promise<SpectrumData | null> {
  const cached = spectrumCache.get(entry.id)
  if (cached) return cached
  const file = entry.file.replace(/\.json$/, '.spectrum.json')
  const p = fetchStaticJson(file)
    .then((d) => {
      const s = d as Partial<SpectrumData>
      if (!s || !Array.isArray(s.exposures) || typeof s.size_px !== 'number') {
        throw new StaticDataError(`${file} has an unexpected shape.`, false)
      }
      return s as SpectrumData
    })
    .catch((e: unknown) => {
      if (e instanceof StaticDataError && e.missing) return null
      throw e
    })
  spectrumCache.set(entry.id, p)
  p.catch(() => spectrumCache.delete(entry.id))
  return p
}
