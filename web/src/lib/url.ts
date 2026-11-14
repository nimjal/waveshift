// Shareable view state in the URL query string:
//   ?target=<id>                curated target
//   ?ra=<deg>&dec=<deg>         custom position (starts a live query when opened)
//   &det=ALL|D1..D6  &view=blink|diff  &stretch=linear|sqrt|asinh   (optional)
// Older links used the hash (#target=… / #ra=…&dec=…); those are still read.
// Parsing never throws: anything unusable is dropped and reported in `problems`, so a bad
// link falls back to the default view with a notice instead of a blank page.

import { validateCoords } from './api'
import { parseDec, parseRa } from './coords'
import type { Stretch, ViewMode } from './render'
import type { DataSource } from './types'

export type UrlSource = DataSource

export interface DisplayState {
  det: string
  mode: ViewMode
  stretch: Stretch
}

export const DEFAULT_DISPLAY: DisplayState = { det: 'ALL', mode: 'blink', stretch: 'asinh' }

export interface UrlState {
  source: UrlSource | null
  display: DisplayState
  /** human-readable notes about parameters that were ignored */
  problems: string[]
}

const MODES: readonly ViewMode[] = ['blink', 'diff']
const STRETCHES: readonly Stretch[] = ['linear', 'sqrt', 'asinh']
const DET = /^(ALL|D[1-6])$/
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

function params(loc: Pick<Location, 'search' | 'hash'>): URLSearchParams {
  const q = new URLSearchParams(loc.search)
  // legacy hash links: only consulted when the query string has no view in it
  if (!q.has('target') && !q.has('ra') && !q.has('dec') && loc.hash.length > 1) {
    const h = new URLSearchParams(loc.hash.slice(1))
    for (const [k, v] of h) if (!q.has(k)) q.set(k, v)
  }
  return q
}

export function readUrl(loc: Pick<Location, 'search' | 'hash'> = window.location): UrlState {
  const q = params(loc)
  const problems: string[] = []
  let source: UrlSource | null = null

  const target = q.get('target')
  const raText = q.get('ra')
  const decText = q.get('dec')
  if (target !== null) {
    if (ID.test(target)) source = { kind: 'curated', id: target }
    else problems.push(`"${target.slice(0, 40)}" is not a valid target id`)
    if (raText !== null || decText !== null) problems.push('both a target and coordinates were given; using the target')
  } else if (raText !== null || decText !== null) {
    const ra = parseRa(raText ?? '')
    const dec = parseDec(decText ?? '')
    const invalid = Number.isNaN(ra) || Number.isNaN(dec) ? 'RA/Dec could not be read' : validateCoords(ra, dec)
    if (invalid) problems.push(`coordinates ignored (${invalid.replace(/\.$/, '')})`)
    else source = { kind: 'custom', ra, dec }
  }

  const display = { ...DEFAULT_DISPLAY }
  const det = q.get('det')
  if (det !== null) {
    if (DET.test(det.toUpperCase())) display.det = det.toUpperCase()
    else problems.push(`unknown detector "${det.slice(0, 20)}"`)
  }
  const mode = q.get('view')
  if (mode !== null) {
    if ((MODES as readonly string[]).includes(mode)) display.mode = mode as ViewMode
    else problems.push(`unknown view "${mode.slice(0, 20)}"`)
  }
  const stretch = q.get('stretch')
  if (stretch !== null) {
    if ((STRETCHES as readonly string[]).includes(stretch)) display.stretch = stretch as Stretch
    else problems.push(`unknown stretch "${stretch.slice(0, 20)}"`)
  }
  return { source, display, problems }
}

/** Coordinates in links: 5 decimals (~0.04″), trailing zeros dropped. */
function fmt(v: number): string {
  return String(Number(v.toFixed(5)))
}

/** The query string for a view; defaults are left out so links stay short. */
export function toSearch(source: UrlSource | null, display: DisplayState): string {
  const q = new URLSearchParams()
  if (source?.kind === 'curated') q.set('target', source.id)
  else if (source?.kind === 'custom') {
    q.set('ra', fmt(source.ra))
    q.set('dec', fmt(source.dec))
  }
  if (display.det !== DEFAULT_DISPLAY.det) q.set('det', display.det)
  if (display.mode !== DEFAULT_DISPLAY.mode) q.set('view', display.mode)
  if (display.stretch !== DEFAULT_DISPLAY.stretch) q.set('stretch', display.stretch)
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function sameSource(a: UrlSource | null, b: UrlSource | null): boolean {
  if (!a || !b) return a === b
  if (a.kind === 'curated' && b.kind === 'curated') return a.id === b.id
  if (a.kind === 'custom' && b.kind === 'custom') return fmt(a.ra) === fmt(b.ra) && fmt(a.dec) === fmt(b.dec)
  return false
}

/** Copy text to the clipboard. navigator.clipboard needs a secure context (HTTPS or
 * localhost); self-hosted plain-HTTP sites fall back to a hidden textarea + execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
