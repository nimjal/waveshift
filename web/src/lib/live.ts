// Progressive refinement for custom RA/Dec (docs/schema.md, "Live API").
//
// GET /target returns a plan (epochs + ordered exposures, no pixels). Each
// POST /target/refine returns per-call DELTAS: per epoch and detector a sum image and a
// per-pixel valid-count image. The server is stateless, so the running sums live here.
// The server only commits whole rounds (the same slot in every epoch), so every epoch is
// always at the same depth with the same detector mix: whatever we render blinks fairly.

import type { Epoch, Frame, SpectrumData, SpectrumExposure, TargetData } from './types'

export interface LiveExposure {
  obs_id: string
  detector: string
}

export interface LivePlan extends Omit<TargetData, 'epochs' | 'n_used'> {
  epochs: (Omit<Epoch, 'frames'> & { exposures: LiveExposure[] })[]
  refine: {
    cursor: string
    /** exposures per epoch once fully refined */
    total: number
    /** detector of each slot, e.g. ["D6","D5","D4",...] */
    slots: string[]
    first_batch: number
    done: boolean
  }
}

export interface LiveFailure {
  slot: number
  obs_id: string
  detector: string
  /** no_coverage | all_masked | unavailable | bad_file | http_NNN | error */
  reason: string
}

export interface RefineResponse {
  cursor: string
  depth: number
  total: number
  done: boolean
  /** rounds committed by this call (0 = no progress, try again shortly) */
  committed: number
  elapsed_s: number
  epochs: {
    id: string
    frames: Record<string, { sum: number[][]; count: number[][]; n_images: number }>
    failed: LiveFailure[]
    /** per-exposure samples for the spectrum (absent from older servers) */
    exposures?: (Omit<SpectrumExposure, 'epoch'> & { slot: number })[]
  }[]
}

export function looksLikePlan(x: unknown): x is LivePlan {
  if (!x || typeof x !== 'object') return false
  const p = x as Partial<LivePlan>
  return !!p.target && !!p.grid && Array.isArray(p.epochs) && !!p.refine && typeof p.refine.cursor === 'string'
}

export function looksLikeRefine(x: unknown): x is RefineResponse {
  if (!x || typeof x !== 'object') return false
  const r = x as Partial<RefineResponse>
  return typeof r.cursor === 'string' && typeof r.depth === 'number' && Array.isArray(r.epochs)
}

interface Acc {
  sum: Float64Array
  count: Int32Array
  n: number
}

/** Running per-epoch, per-detector sums. Immutable snapshots via toTargetData(). */
export class LiveStack {
  readonly plan: LivePlan
  cursor: string
  depth = 0
  done: boolean
  private readonly acc: Map<string, Acc>[]
  readonly failures: LiveFailure[][]
  private readonly samples: SpectrumExposure[] = []

  constructor(plan: LivePlan) {
    this.plan = plan
    this.cursor = plan.refine.cursor
    this.done = plan.refine.done
    this.acc = plan.epochs.map(() => new Map())
    this.failures = plan.epochs.map(() => [])
  }

  get total(): number {
    return this.plan.refine.total
  }

  add(res: RefineResponse): void {
    const n = this.plan.grid.size_px
    res.epochs.forEach((ep) => {
      const i = this.plan.epochs.findIndex((e) => e.id === ep.id)
      if (i < 0) return
      for (const [det, f] of Object.entries(ep.frames)) {
        let a = this.acc[i].get(det)
        if (!a) {
          a = { sum: new Float64Array(n * n), count: new Int32Array(n * n), n: 0 }
          this.acc[i].set(det, a)
        }
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < n; c++) {
            a.sum[r * n + c] += f.sum[r]?.[c] ?? 0
            a.count[r * n + c] += f.count[r]?.[c] ?? 0
          }
        }
        a.n += f.n_images
      }
      this.failures[i].push(...ep.failed)
      for (const x of ep.exposures ?? []) {
        this.samples.push({
          epoch: ep.id,
          detector: x.detector,
          obs_id: x.obs_id,
          wave: x.wave,
          bandwidth: x.bandwidth,
          pixels: x.pixels,
        })
      }
    })
    this.cursor = res.cursor
    this.depth = res.depth
    this.done = res.done
  }

  /** Snapshot of the per-exposure samples fetched so far (live frames have no blank reasons). */
  spectrumData(): SpectrumData {
    const n = this.plan.grid.size_px
    return { size_px: n, wave_origin_px: (n - 1) / 2, exposures: [...this.samples] }
  }

  /** Total skipped exposures across epochs. */
  get failedCount(): number {
    return this.failures.reduce((s, f) => s + f.length, 0)
  }

  /** Mean image (sum / count) per detector plus ALL (every detector pooled). */
  toTargetData(): TargetData {
    const n = this.plan.grid.size_px
    const frame = (parts: Acc[]): Frame | null => {
      const used = parts.reduce((s, p) => s + p.n, 0)
      if (used === 0) return null
      const pixels: (number | null)[][] = []
      let blank = 0
      for (let r = 0; r < n; r++) {
        const row: (number | null)[] = []
        for (let c = 0; c < n; c++) {
          let s = 0
          let k = 0
          for (const p of parts) {
            s += p.sum[r * n + c]
            k += p.count[r * n + c]
          }
          if (k > 0) row.push(s / k)
          else {
            row.push(null)
            blank++
          }
        }
        pixels.push(row)
      }
      return { n_images: used, pixels, flagged_fraction: Math.round((blank / (n * n)) * 1e4) / 1e4 }
    }

    let nUsed = 0
    const epochs: Epoch[] = this.plan.epochs.map(({ exposures: _exposures, ...ep }, i) => {
      const frames: Record<string, Frame> = {}
      const parts = [...this.acc[i].entries()]
      for (const [det, a] of parts) {
        const f = frame([a])
        if (f) frames[det] = f
      }
      const all = frame(parts.map(([, a]) => a))
      if (all) {
        frames.ALL = all
        nUsed += all.n_images
      }
      return { ...ep, frames }
    })
    const { refine: _refine, ...rest } = this.plan
    return { ...rest, epochs, n_used: nUsed }
  }
}

/** "B: 2 skipped (all_masked ×2)" lines for epochs with failures. */
export function describeFailures(stack: LiveStack): string[] {
  return stack.plan.epochs.flatMap((ep, i) => {
    const f = stack.failures[i]
    if (f.length === 0) return []
    const by = new Map<string, number>()
    for (const x of f) by.set(x.reason, (by.get(x.reason) ?? 0) + 1)
    const parts = [...by.entries()].map(([r, k]) => `${r.replace('_', ' ')} ×${k}`).join(', ')
    return [`${ep.id}: ${f.length} skipped (${parts})`]
  })
}
