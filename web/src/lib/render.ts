// Turn epoch pixel grids into small offscreen canvases (1 canvas pixel per sky pixel).
// The player scales them up with smoothing off, so blinking is just drawImage.
//
// One stretch is computed per (detector, view) across ALL epochs; scaling each frame on
// its own would make the blink show brightness changes instead of motion.

import { reasonAt, reasonsOf, REASON_STYLES, type RGB } from './reasons'
import type { Pixels, TargetData } from './types'

export type Stretch = 'linear' | 'sqrt' | 'asinh'
export type ViewMode = 'blink' | 'diff'

/** Fill for a whole missing frame ("No D3 data in this epoch"): the not_observed colour. */
export const NO_FRAME_RGB: RGB = REASON_STYLES.not_observed.rgb

/** True when the target's core is mostly saturated: in most epochs, at least 5 of the 9
 * pixels around the predicted position in the ALL frame are saturated. */
export function coreSaturated(data: TargetData): boolean {
  const size = data.grid.size_px
  const table = reasonsOf(data)
  let hits = 0
  let seen = 0
  for (const ep of data.epochs) {
    const f = ep.frames.ALL
    if (!f) continue
    seen++
    const cx = Math.round(ep.predicted_px.x)
    const cy = Math.round(ep.predicted_px.y)
    let n = 0
    for (let r = cy - 1; r <= cy + 1; r++)
      for (let c = cx - 1; c <= cx + 1; c++) if (r >= 0 && c >= 0 && r < size && c < size && reasonAt(f, table, r, c)?.key === 'saturated') n++
    if (n >= 5) hits++
  }
  return seen > 0 && hits * 2 > seen
}

export interface RenderedFrames {
  /** one canvas per epoch, or null if that epoch has no frame for this detector */
  canvases: (HTMLCanvasElement | null)[]
  /** display range in data units: blink = [lo, hi], diff = [-s, +s] */
  range: [number, number]
}

/** Frame keys present in at least one epoch: ALL first, then D1..D6 in order. */
export function availableFrameKeys(data: TargetData): string[] {
  const keys = new Set<string>()
  for (const ep of data.epochs) for (const k of Object.keys(ep.frames)) keys.add(k)
  return [...keys].sort((a, b) => (a === 'ALL' ? -1 : b === 'ALL' ? 1 : a.localeCompare(b, 'en', { numeric: true })))
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[i]
}

function finiteSorted(values: number[]): Float64Array {
  const a = Float64Array.from(values.filter(Number.isFinite))
  a.sort()
  return a
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Map t in [0, 1] through the stretch. */
function applyStretch(t: number, stretch: Stretch): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  switch (stretch) {
    case 'linear':
      return c
    case 'sqrt':
      return Math.sqrt(c)
    case 'asinh': {
      const beta = 0.05 // softening: smaller = stronger compression of bright cores
      return Math.asinh(c / beta) / Math.asinh(1 / beta)
    }
  }
}

function paint(size: number, rgbAt: (row: number, col: number) => [number, number, number]): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const [R, G, B] = rgbAt(r, c)
      const o = (r * size + c) * 4
      img.data[o] = R
      img.data[o + 1] = G
      img.data[o + 2] = B
      img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

function cell(p: Pixels, r: number, c: number): number | null {
  const v = p[r]?.[c]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Diverging map for difference images: blue (fainter) ← black → amber (brighter). */
function diverging(t: number): [number, number, number] {
  const a = Math.min(1, Math.abs(t))
  return t >= 0
    ? [Math.round(255 * a), Math.round(190 * a), Math.round(60 * a * a)]
    : [Math.round(60 * a * a), Math.round(150 * a), Math.round(255 * a)]
}

export function renderFrames(data: TargetData, key: string, mode: ViewMode, stretch: Stretch): RenderedFrames {
  const size = data.grid.size_px
  const frames = data.epochs.map((ep) => ep.frames[key])
  const grids = frames.map((f) => f?.pixels ?? null)
  const table = reasonsOf(data)
  // a blank pixel is drawn in its reason's colour; unknown/missing reasons -> unexplained
  const blankRgb = (i: number, r: number, c: number): RGB => (reasonAt(frames[i], table, r, c) ?? table.unexplained).style.rgb

  if (mode === 'blink') {
    const all: number[] = []
    for (const g of grids) if (g) for (const row of g) for (const v of row) if (v !== null) all.push(v)
    const sorted = finiteSorted(all)
    const lo = percentile(sorted, 1)
    let hi = percentile(sorted, 99.7)
    if (!(hi > lo)) hi = lo + 1
    const canvases = grids.map((g, i) =>
      g
        ? paint(size, (r, c) => {
            const v = cell(g, r, c)
            if (v === null) return blankRgb(i, r, c)
            const y = Math.round(255 * applyStretch((v - lo) / (hi - lo), stretch))
            return [y, y, y]
          })
        : null,
    )
    return { canvases, range: [lo, hi] }
  }

  // Difference: each epoch minus the per-pixel median over all epochs. Static sky cancels;
  // a mover shows up bright where it is now and dark where it was.
  const ref: (number | null)[][] = []
  for (let r = 0; r < size; r++) {
    ref.push([])
    for (let c = 0; c < size; c++) {
      const vals: number[] = []
      for (const g of grids) {
        const v = g ? cell(g, r, c) : null
        if (v !== null) vals.push(v)
      }
      ref[r].push(median(vals))
    }
  }
  const diffs = grids.map((g) =>
    g
      ? g.map((row, r) =>
          row.map((_, c) => {
            const v = cell(g, r, c)
            const m = ref[r][c]
            return v === null || m === null ? null : v - m
          }),
        )
      : null,
  )
  const abs: number[] = []
  for (const d of diffs) if (d) for (const row of d) for (const v of row) if (v !== null) abs.push(Math.abs(v))
  let s = percentile(finiteSorted(abs), 99.5)
  if (!(s > 0)) s = 1
  // a diff pixel is null exactly when the frame's own pixel is null (if it has a value, the
  // median over epochs does too), so the frame's reason explains it
  const canvases = diffs.map((d, i) =>
    d
      ? paint(size, (r, c) => {
          const v = d[r][c]
          if (v === null) return blankRgb(i, r, c)
          const t = v / s
          return diverging(Math.sign(t) * applyStretch(Math.abs(t), stretch))
        })
      : null,
  )
  return { canvases, range: [-s, s] }
}

/** Total proper motion in screen pixels per year (0 for custom positions). */
export function motionPxPerYear(data: TargetData): number {
  const { pmra, pmdec } = data.target
  return Math.hypot(pmra, pmdec) / 1000 / data.grid.pixel_scale_arcsec
}
