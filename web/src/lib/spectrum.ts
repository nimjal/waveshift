// Sampling the per-exposure spectrum at one pixel (see components/SpectrumPanel.tsx).

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

export type Skipped = { saturated: number; flagged: number; noData: number }

/** Every exposure's value + wavelength at the picked pixel. Blank samples are left out and counted. */
export function sampleSpectrum(spec: SpectrumData, data: TargetData, pick: Pick): { samples: Sample[]; skipped: Skipped } {
  const epochIdx = new Map(data.epochs.map((e, i) => [e.id, i]))
  const o = spec.wave_origin_px
  const n = spec.size_px
  const samples: Sample[] = []
  const skipped: Skipped = { saturated: 0, flagged: 0, noData: 0 }
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
      skipped.noData++
      continue
    }
    const v = x.pixels[r]?.[c]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      const code = x.reasons?.[r]?.charAt(c)
      if (code === '1') skipped.saturated++
      else if (code === '2') skipped.flagged++
      else skipped.noData++
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
  return { samples, skipped }
}

