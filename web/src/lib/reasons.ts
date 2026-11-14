// Why a blank (null) pixel is blank (docs/schema.md, "Blank-pixel reasons").
//
// Codes, keys, labels and priority come from the data (`reason_table` in every target file
// and in GET /target); nothing here depends on which digit means what. This module only owns
// how each reason KEY looks. Anything it doesn't recognise (no table, an unknown code, a key
// without a style, a null pixel without reasons) is shown as "unexplained", with its own style,
// so no pixel is ever drawn in an unlabelled colour.

import type { Frame, ReasonTable, TargetData } from './types'

/** Anything with pixels + reasons: a stacked frame or one spectrum exposure. */
export type FrameLike = Pick<Frame, 'pixels' | 'reasons' | 'other_flags'>

export type RGB = [number, number, number]
/** Line pattern drawn over a reason's cells at display scale ('none' = flat colour). */
export type Pattern = '/' | '\\' | '-' | '|' | 'x' | '+' | 'dots' | 'none'

export interface ReasonStyle {
  rgb: RGB
  pattern: Pattern
  /** colour of the pattern lines */
  ink: string
}

export const UNEXPLAINED = 'unexplained'
const FALLBACK_LABEL = 'Unexplained'

/** Per-key look. Hues avoid the grey blink ramp and the blue/amber difference map; every
 * reason also has its own pattern, so they stay apart without colour vision. Saturated keeps
 * its crimson + diagonal hatch. */
export const REASON_STYLES: Record<string, ReasonStyle> = {
  saturated: { rgb: [150, 22, 58], pattern: '/', ink: 'rgba(255, 210, 220, 0.75)' },
  defect: { rgb: [38, 104, 56], pattern: 'dots', ink: 'rgba(205, 255, 215, 0.8)' },
  transient: { rgb: [92, 52, 150], pattern: '-', ink: 'rgba(225, 210, 255, 0.7)' },
  persistence: { rgb: [18, 104, 112], pattern: '\\', ink: 'rgba(200, 250, 255, 0.7)' },
  missing: { rgb: [112, 72, 28], pattern: '|', ink: 'rgba(255, 228, 195, 0.7)' },
  other_flag: { rgb: [118, 112, 24], pattern: 'x', ink: 'rgba(255, 252, 200, 0.7)' },
  not_observed: { rgb: [96, 24, 84], pattern: 'none', ink: 'transparent' },
  [UNEXPLAINED]: { rgb: [58, 58, 66], pattern: '+', ink: 'rgba(255, 140, 140, 0.8)' },
}

/** One resolved reason: what the legend and the hover readout show. */
export interface Reason {
  key: string
  label: string
  style: ReasonStyle
}

/** Code -> reason, plus the priority rank used to fold live deltas. */
export class Reasons {
  private readonly byCode = new Map<number, Reason>()
  private readonly rankOf = new Map<number, number>()
  readonly unexplained: Reason
  /** code to store for a blank pixel that no exposure covered (null if the table has none) */
  readonly notObservedCode: number | null

  constructor(table: ReasonTable | undefined) {
    let unexplained: Reason | null = null
    let notObserved: number | null = null
    for (const [k, v] of Object.entries(table ?? {})) {
      const code = Number(k)
      if (!Number.isInteger(code) || code === 0 || !v || typeof v.key !== 'string') continue
      const style = REASON_STYLES[v.key]
      // a key we have no style for is drawn as unexplained, but keeps its own label
      const r: Reason = { key: style ? v.key : UNEXPLAINED, label: v.label || v.key, style: style ?? REASON_STYLES[UNEXPLAINED] }
      this.byCode.set(code, r)
      if (typeof v.rank === 'number') this.rankOf.set(code, v.rank)
      if (v.key === UNEXPLAINED) unexplained = r
      if (v.key === 'not_observed') notObserved = code
    }
    this.unexplained = unexplained ?? { key: UNEXPLAINED, label: FALLBACK_LABEL, style: REASON_STYLES[UNEXPLAINED] }
    this.notObservedCode = notObserved
  }

  /** The reason for a code; unknown codes are unexplained. */
  get(code: number): Reason {
    return this.byCode.get(code) ?? this.unexplained
  }

  /** Priority (lower wins). 0 = nothing seen, ranks below everything; unknown codes just above it. */
  rank(code: number): number {
    if (code === 0) return Number.POSITIVE_INFINITY
    return this.rankOf.get(code) ?? Number.MAX_SAFE_INTEGER
  }
}

const cache = new WeakMap<object, Reasons>()
const EMPTY = {}

/** Resolved reason table of a target (memoised per table object). */
export function reasonsOf(data: Pick<TargetData, 'reason_table'>): Reasons {
  const t = data.reason_table ?? EMPTY
  let r = cache.get(t)
  if (!r) {
    r = new Reasons(data.reason_table)
    cache.set(t, r)
  }
  return r
}

function isValue(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Stored code for a pixel: 0 if it has a value, else the digit in `reasons` (-1 if none). */
export function codeAt(frame: FrameLike | undefined, r: number, c: number): number {
  if (!frame) return -1
  if (isValue(frame.pixels[r]?.[c])) return 0
  const ch = frame.reasons?.[r]?.charCodeAt(c)
  return ch === undefined || ch < 48 || ch > 57 ? -1 : ch - 48
}

/** The reason for a blank pixel, or null for a valid one. Missing/unknown -> unexplained. */
export function reasonAt(frame: FrameLike | undefined, table: Reasons, r: number, c: number): Reason | null {
  const code = codeAt(frame, r, c)
  if (code === 0) return null
  return code < 0 ? table.unexplained : table.get(code)
}

/** Reasons occurring in a frame, in table order (for the legend). */
export function reasonsPresent(frame: FrameLike | undefined, table: Reasons, size: number): Reason[] {
  const seen = new Set<Reason>()
  if (!frame) return []
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) {
      const x = reasonAt(frame, table, r, c)
      if (x) seen.add(x)
    }
  return [...seen].sort((a, b) => order(a) - order(b))
}

const KEY_ORDER = Object.keys(REASON_STYLES)
const order = (r: Reason) => {
  const i = KEY_ORDER.indexOf(r.key)
  return i < 0 ? KEY_ORDER.length : i
}

/** Plane behind an other_flag pixel (screen row/col), if the data names one. */
export function planeAt(frame: FrameLike | undefined, r: number, c: number): string | null {
  for (const [name, px] of Object.entries(frame?.other_flags ?? {})) if (px.some(([y, x]) => y === r && x === c)) return name
  return null
}

/** Hover text for a blank pixel: the label, plus the FLAGS plane for other_flag. */
export function reasonText(frame: FrameLike | undefined, reason: Reason, r: number, c: number): string {
  const plane = reason.key === 'other_flag' ? planeAt(frame, r, c) : null
  return plane ? `${reason.label}: ${plane}` : reason.label
}

// ------------------------------------------------------------------------------ drawing

/** Draw `pattern` over the clip region (the caller clips to the reason's cells). */
function strokePattern(ctx: CanvasRenderingContext2D, pattern: Pattern, full: number, step = 6) {
  ctx.beginPath()
  const diag = (dir: 1 | -1) => {
    for (let d = -full; d < full; d += step) {
      if (dir === 1) {
        ctx.moveTo(d, full)
        ctx.lineTo(d + full, 0)
      } else {
        ctx.moveTo(d, 0)
        ctx.lineTo(d + full, full)
      }
    }
  }
  const horiz = () => {
    for (let y = step / 2; y < full; y += step) {
      ctx.moveTo(0, y)
      ctx.lineTo(full, y)
    }
  }
  const vert = () => {
    for (let x = step / 2; x < full; x += step) {
      ctx.moveTo(x, 0)
      ctx.lineTo(x, full)
    }
  }
  switch (pattern) {
    case '/':
      diag(1)
      break
    case '\\':
      diag(-1)
      break
    case '-':
      horiz()
      break
    case '|':
      vert()
      break
    case 'x':
      diag(1)
      diag(-1)
      break
    case '+':
      horiz()
      vert()
      break
    case 'dots':
      for (let y = step / 2; y < full; y += step) for (let x = step / 2; x < full; x += step) ctx.rect(x - 1, y - 1, 2, 2)
      ctx.fillStyle = ctx.strokeStyle
      ctx.fill()
      return
    case 'none':
      return
  }
  ctx.stroke()
}

/** Each reason's pattern over its cells, at display scale (the flat colours are in the frame canvas). */
export function drawReasonPatterns(
  ctx: CanvasRenderingContext2D,
  frame: FrameLike | undefined,
  table: Reasons,
  size: number,
  cell: number,
) {
  if (!frame) return
  const cells = new Map<Reason, [number, number][]>()
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) {
      const x = reasonAt(frame, table, r, c)
      if (x && x.style.pattern !== 'none') {
        const list = cells.get(x)
        if (list) list.push([r, c])
        else cells.set(x, [[r, c]])
      }
    }
  const full = size * cell
  for (const [reason, list] of cells) {
    ctx.save()
    ctx.beginPath()
    for (const [r, c] of list) ctx.rect(c * cell, r * cell, cell, cell)
    ctx.clip()
    ctx.strokeStyle = reason.style.ink
    ctx.lineWidth = 1.5
    strokePattern(ctx, reason.style.pattern, full)
    ctx.restore()
  }
}

/** CSS background for a legend swatch showing the same colour + pattern. */
export function swatchBackground(style: ReasonStyle): string {
  const base = `rgb(${style.rgb.join(',')})`
  const lines = (deg: number) => `repeating-linear-gradient(${deg}deg, ${style.ink} 0 1.5px, transparent 1.5px 4px)`
  switch (style.pattern) {
    case '/':
      return `${lines(-45)}, ${base}`
    case '\\':
      return `${lines(45)}, ${base}`
    case '-':
      return `${lines(0)}, ${base}`
    case '|':
      return `${lines(90)}, ${base}`
    case 'x':
      return `${lines(-45)}, ${lines(45)}, ${base}`
    case '+':
      return `${lines(0)}, ${lines(90)}, ${base}`
    case 'dots':
      return `radial-gradient(${style.ink} 1px, transparent 1.2px) 0 0 / 4px 4px, ${base}`
    case 'none':
      return base
  }
}

// --------------------------------------------------------------------- live accumulation

/** Per-pixel folded reason codes (+ other_flag plane names), row 0 = top. */
export class ReasonAcc {
  readonly codes: Uint8Array
  readonly names = new Map<number, string>()
  readonly n: number
  constructor(n: number) {
    this.n = n
    this.codes = new Uint8Array(n * n)
  }

  /** Fold one delta (`reasons` strings + `other_flags`): the lower rank wins, 0 = nothing seen.
   * Same rule as planetx/reasons.py merge. */
  add(table: Reasons, reasons: string[] | undefined, otherFlags: Record<string, [number, number][]> | undefined) {
    if (!reasons) return
    const n = this.n
    const plane = new Map<number, string>()
    for (const [name, px] of Object.entries(otherFlags ?? {})) for (const [y, x] of px) plane.set(y * n + x, name)
    for (let r = 0; r < n; r++) {
      const row = reasons[r]
      if (!row) continue
      for (let c = 0; c < n; c++) {
        const ch = row.charCodeAt(c)
        if (!(ch >= 49 && ch <= 57)) continue
        const code = ch - 48
        const i = r * n + c
        if (table.rank(code) < table.rank(this.codes[i])) {
          this.codes[i] = code
          const p = plane.get(i)
          if (p) this.names.set(i, p)
          else this.names.delete(i)
        }
      }
    }
  }

  /** Fold another accumulator in (used for ALL = every detector). */
  merge(table: Reasons, other: ReasonAcc) {
    for (let i = 0; i < this.codes.length; i++) {
      const code = other.codes[i]
      if (table.rank(code) < table.rank(this.codes[i])) {
        this.codes[i] = code
        const p = other.names.get(i)
        if (p) this.names.set(i, p)
        else this.names.delete(i)
      }
    }
  }
}

/** Frame `reasons` / `other_flags` for a live stack: blank pixels get the folded code, or
 * not_observed when no exposure said anything about them. */
export function liveFrameReasons(
  table: Reasons,
  acc: ReasonAcc | null,
  blank: (i: number) => boolean,
  n: number,
): Pick<Frame, 'reasons' | 'other_flags'> {
  const rows: string[] = []
  const other: Record<string, [number, number][]> = {}
  let any = false
  for (let r = 0; r < n; r++) {
    let row = ''
    for (let c = 0; c < n; c++) {
      const i = r * n + c
      let code = 0
      if (blank(i)) {
        code = acc?.codes[i] || table.notObservedCode || 0
        if (code === 0) code = -1 // no table at all: '?' -> unexplained
        any = true
        const p = acc?.names.get(i)
        if (p && acc && code === acc.codes[i] && table.get(code).key === 'other_flag') (other[p] ??= []).push([r, c])
      }
      row += code < 0 ? '?' : String(code)
    }
    rows.push(row)
  }
  if (!any) return {}
  return Object.keys(other).length ? { reasons: rows, other_flags: other } : { reasons: rows }
}
