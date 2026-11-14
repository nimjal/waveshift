// Sampling the per-exposure spectrum at one pixel (see components/SpectrumPanel.tsx).

import { reasonAt, reasonsOf } from './reasons'
import type { SpectrumData, TargetData } from './types'

export interface Pick {
  r: number
  c: number
  /** sample each epoch at its own predicted target position instead of a fixed pixel */
  follow: boolean
}

export interface Sample {
  lam: number
  value: number
  epoch: number
  detector: string
  obs_id: string
}

/** Blank samples left out, per reason label (from the data's reason_table), most first. */
export type Skipped = { label: string; n: number }[]

/** Every exposure's value + wavelength at the picked pixel. Blank samples are left out and counted. */
export function sampleSpectrum(spec: SpectrumData, data: TargetData, pick: Pick): { samples: Sample[]; skipped: Skipped } {
  const epochIdx = new Map(data.epochs.map((e, i) => [e.id, i]))
  const o = spec.wave_origin_px
  const n = spec.size_px
  const samples: Sample[] = []
  const table = reasonsOf(data)
  const left = new Map<string, number>()
  const skip = (label: string) => left.set(label, (left.get(label) ?? 0) + 1)
  const outside = table.notObservedCode === null ? table.unexplained : table.get(table.notObservedCode)
  for (const x of spec.exposures) {
    const ei = epochIdx.get(x.epoch)
    if (ei === undefined) continue
    let r = pick.r
    let c = pick.c
    if (pick.follow) {
      const p = data.epochs[ei].predicted_px
      r = Math.round(p.y)
      c = Math.round(p.x)
    }
    if (r < 0 || c < 0 || r >= n || c >= n) {
      skip(outside.label) // followed the target off the grid
      continue
    }
    const v = x.pixels[r]?.[c]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      skip((reasonAt(x, table, r, c) ?? table.unexplained).label)
      continue
    }
    samples.push({
      lam: x.wave[0] + x.wave[1] * (c - o) + x.wave[2] * (r - o),
      value: v,
      epoch: ei,
      detector: x.detector,
      obs_id: x.obs_id,
    })
  }
  samples.sort((a, b) => a.lam - b.lam)
  const skipped: Skipped = [...left].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n)
  return { samples, skipped }
}

