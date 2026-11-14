// Brightness against epoch date for the target in one detector (planetx/photometry.py):
// fixed-aperture photometry on the stacked frames, one point per epoch, with error bars.
//
// One series, so no legend box: the heading names it. Colour is series-1 (validated in the
// spectrum panel's palette). Hollow markers = many aperture pixels were blank and left out.
// Curated targets carry the light curve in their JSON; live views fetch it from POST
// /photometry with the frames they hold (refetched, debounced, as the stack refines).

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { API_URL, fetchLightcurve } from '@/lib/api'
import type { Lightcurve, LightcurveDetector, TargetData } from '@/lib/types'
import { cn } from '@/lib/utils'

const COLOR = 'var(--series-1)'
const DETS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']
const M = { top: 14, right: 22, bottom: 52, left: 58 }

function fmt(v: number): string {
  const a = Math.abs(v)
  if (a !== 0 && (a < 0.01 || a >= 10000)) return v.toExponential(1)
  return Number(v.toPrecision(3)).toString()
}

function niceTicks(lo: number, hi: number, count = 5): number[] {
  const span = hi - lo || 1
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? raw
  const out: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Number(t.toPrecision(10)))
  return out
}

interface Pt {
  epoch: string
  label: string
  mjd: number
  v: number
  err: number
  hollow: boolean
  excluded: string
}

function Plot({ pts, unit, ariaLabel }: { pts: Pt[]; unit: string; ariaLabel: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(520)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const H = Math.round(Math.min(260, Math.max(190, W * 0.45)))
  const iw = W - M.left - M.right
  const ih = H - M.top - M.bottom
  const t0 = Math.min(...pts.map((p) => p.mjd))
  const t1 = Math.max(...pts.map((p) => p.mjd))
  const tpad = (t1 - t0 || 60) * 0.12
  const x0 = t0 - tpad
  const x1 = t1 + tpad
  // magnitude: the y axis starts at zero so a change reads at its true proportion
  const hi = Math.max(...pts.map((p) => p.v + p.err)) * 1.1 || 1
  const lo = Math.min(0, ...pts.map((p) => p.v - p.err))
  const sx = (t: number) => M.left + ((t - x0) / (x1 - x0)) * iw
  const sy = (v: number) => M.top + (1 - (v - lo) / (hi - lo)) * ih
  const yt = niceTicks(lo, hi, 4).filter((t) => t >= lo && t <= hi)

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - box.left) / box.width) * W
    let best: number | null = null
    let bd = 28
    pts.forEach((p, i) => {
      const d = Math.abs(sx(p.mjd) - px)
      if (d < bd) {
        bd = d
        best = i
      }
    })
    setHover(best)
  }
  const h = hover !== null ? pts[hover] : null

  return (
    <div className="relative" ref={wrap}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full touch-none"
        role="img"
        aria-label={ariaLabel}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {yt.map((t) => (
          <g key={`y${t}`}>
            <line x1={M.left} x2={W - M.right} y1={sy(t)} y2={sy(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={M.left - 6} y={sy(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px]">
              {fmt(t)}
            </text>
          </g>
        ))}
        <line x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} stroke="var(--muted-foreground)" />
        {pts.map((p, i) => {
          // two-line tick label (epoch letter, then date); the date is dropped when it would
          // collide with a neighbour's (~56 px for "May 2025" at 11 px)
          const x = sx(p.mjd)
          const gap = Math.min(
            i > 0 ? x - sx(pts[i - 1].mjd) : Infinity,
            i < pts.length - 1 ? sx(pts[i + 1].mjd) - x : Infinity,
          )
          return (
            <g key={`x${p.epoch}`}>
              <line x1={x} x2={x} y1={H - M.bottom} y2={H - M.bottom + 4} stroke="var(--muted-foreground)" />
              <text x={x} y={H - M.bottom + 15} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                <tspan className="font-semibold">{p.epoch}</tspan>
                {gap >= 58 && (
                  <tspan x={x} dy="1.2em">
                    {p.label}
                  </tspan>
                )}
              </text>
            </g>
          )
        })}
        <text x={M.left + iw / 2} y={H - 4} textAnchor="middle" className="fill-muted-foreground text-[11px]">
          Epoch (date)
        </text>
        <text
          transform={`translate(12 ${M.top + ih / 2}) rotate(-90)`}
          textAnchor="middle"
          className="fill-muted-foreground text-[11px]"
        >
          {unit}
        </text>
        {/* error bars, then markers on top with a surface ring */}
        {pts.map((p) => {
          const x = sx(p.mjd)
          return (
            <g key={`e${p.epoch}`} stroke={COLOR} strokeWidth={1.5}>
              <line x1={x} x2={x} y1={sy(p.v - p.err)} y2={sy(p.v + p.err)} />
              <line x1={x - 4} x2={x + 4} y1={sy(p.v - p.err)} y2={sy(p.v - p.err)} />
              <line x1={x - 4} x2={x + 4} y1={sy(p.v + p.err)} y2={sy(p.v + p.err)} />
            </g>
          )
        })}
        {pts.map((p) => (
          <circle
            key={`m${p.epoch}`}
            cx={sx(p.mjd)}
            cy={sy(p.v)}
            r={4.5}
            fill={p.hollow ? 'var(--card)' : COLOR}
            stroke={p.hollow ? COLOR : 'var(--card)'}
            strokeWidth={2}
          />
        ))}
        {h && <circle cx={sx(h.mjd)} cy={sy(h.v)} r={8} fill="none" stroke="var(--foreground)" strokeWidth={1.5} />}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute top-1 right-1 rounded-md border border-border bg-popover px-2 py-1 font-mono text-xs text-popover-foreground shadow"
          role="status"
        >
          {h.epoch} · {h.label}
          <br />
          {fmt(h.v)} ± {fmt(h.err)} {unit.replace(/^.*\((.*)\)$/, '$1')}
          <br />
          {h.excluded}
        </div>
      )}
    </div>
  )
}

function Notes({ lc, d, det }: { lc: Lightcurve; d: LightcurveDetector; det: string }) {
  const ap = d.aperture_px
  const anyHollow = d.points.some((p) => p.many_excluded)
  return (
    <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
      {d.mode === 'outer_glow' && ap && (
        <li>
          <strong className="text-foreground">The core is blank (saturated)</strong>, so this is the brightness of a
          ring {ap[0].toFixed(1)}–{ap[1].toFixed(1)} px from the star (its outer glow), not its total flux. It still rises
          and falls with the star.
        </li>
      )}
      {d.normalised && d.comparison ? (
        <li>
          Relative photometry: the target's flux divided by a comparison star's (x {d.comparison.x}, y{' '}
          {d.comparison.y}) in the same {det} frame, so changes that hit both stars (e.g. calibration between epochs)
          cancel. Assumes that star is constant.
        </li>
      ) : (
        <li>
          <strong className="text-foreground">Not normalised:</strong> no isolated comparison star with S/N ≥{' '}
          {lc.comp_min_snr} in every epoch of {det}, so this is the raw flux in mJy.
        </li>
      )}
      <li>
        Fixed aperture{ap && d.mode === 'aperture' ? ` (radius ${ap[1]} px)` : ''} at the same spot in every epoch,
        background = median of a surrounding ring. Error bars come from that ring's pixel scatter only, so the real
        uncertainty is larger.
      </li>
      {lc.track_px > 0.5 && (
        <li>
          The target moves {lc.track_px.toFixed(1)} px across these epochs and the aperture stays put, so part of a change
          can come from the motion.
        </li>
      )}
      {anyHollow && (
        <li>
          Hollow points: more than {Math.round(lc.excluded_warn_frac * 100)}% of the aperture's pixels were blank and left
          out, so the value is biased low.
        </li>
      )}
      <li>
        SPHEREx sees each epoch's exposures at slightly different wavelengths within {det}, so for a very red or blue
        star part of a change can be colour, not time.
      </li>
    </ul>
  )
}

interface Props {
  data: TargetData
  /** the player's detector; ALL has no light curve */
  detector: string
  onPickDetector: (det: string) => void
  onClose: () => void
}

export function LightCurvePanel({ data, detector, onPickDetector, onClose }: Props) {
  const live = data.target.kind === 'custom'
  const [fetched, setFetched] = useState<Lightcurve | 'loading' | 'error' | null>(null)

  // live views: (re)measure the current stack, debounced, and keep the last result meanwhile
  useEffect(() => {
    if (!live || !API_URL || data.epochs.length === 0) return
    const ctrl = new AbortController()
    const t = window.setTimeout(() => {
      setFetched((f) => (f && typeof f === 'object' ? f : 'loading'))
      fetchLightcurve(data, ctrl.signal).then(
        (lc) => setFetched(lc),
        () => !ctrl.signal.aborted && setFetched((f) => (f && typeof f === 'object' ? f : 'error')),
      )
    }, 800)
    return () => {
      window.clearTimeout(t)
      ctrl.abort()
    }
  }, [data, live])

  const lc = live ? (fetched && typeof fetched === 'object' ? fetched : null) : (data.lightcurve ?? null)
  const d = lc?.detectors[detector]
  const available = lc ? DETS.filter((k) => lc.detectors[k]?.measurable) : []
  const unit = d?.normalised ? 'Brightness (× comparison star)' : 'Flux (mJy)'

  let body
  if (live && !API_URL) body = <p className="text-sm text-muted-foreground">Light curves of live views need the API.</p>
  else if (live && (fetched === 'loading' || fetched === null))
    body = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Measuring the current stack…
      </p>
    )
  else if (live && fetched === 'error')
    body = <p className="text-sm text-muted-foreground">Couldn't measure the light curve right now.</p>
  else if (!lc)
    body = <p className="text-sm text-muted-foreground">This build has no light curve. Run `planetx annotate`.</p>
  else if (!d || !d.measurable) {
    body = (
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">
        <p>
          {detector === 'ALL'
            ? 'The light curve is measured one detector at a time: the stacked "All detectors" view mixes wavelengths differently in each epoch. Pick one:'
            : d?.reason === 'core_too_large'
              ? `In ${detector} the saturated core fills too much of the field to measure. Pick another detector:`
              : `No light curve in ${detector}. Pick another detector:`}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {available.map((k) => (
            <Button key={k} size="xs" variant="outline" onClick={() => onPickDetector(k)}>
              {k}
              {data.detectors[k] && (
                <span className="text-muted-foreground">
                  {' '}
                  {data.detectors[k][0].toFixed(1)}–{data.detectors[k][1].toFixed(1)} µm
                </span>
              )}
            </Button>
          ))}
        </div>
      </div>
    )
  } else {
    const label = (id: string) => data.epochs.find((e) => e.id === id)?.label ?? id
    const pts: Pt[] = d.points
      .map((p) => {
        const v = d.normalised ? p.rel : p.flux
        const err = d.normalised ? p.rel_err : p.flux_err
        if (v === null || err === null) return null
        return {
          epoch: p.epoch,
          label: label(p.epoch),
          mjd: p.mjd,
          v,
          err,
          hollow: p.many_excluded,
          excluded: `${p.n_excluded ?? '?'} of ${p.n_aperture} px excluded`,
        }
      })
      .filter((p): p is Pt => p !== null)
    const range = data.detectors[detector]
    body = (
      <>
        <Plot
          pts={pts}
          unit={unit}
          ariaLabel={`Light curve of ${data.target.name} in ${detector}: ${pts
            .map((p) => `${p.label} ${fmt(p.v)}`)
            .join(', ')}`}
        />
        <Notes lc={lc} d={d} det={range ? `${detector} (${range[0].toFixed(2)}–${range[1].toFixed(2)} µm)` : detector} />
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Show values as a table</summary>
          <div className="mt-2 overflow-x-auto rounded border border-border">
            <table className="w-full font-mono">
              <thead className="bg-muted text-left">
                <tr>
                  <th className="px-2 py-1">Epoch</th>
                  <th className="px-2 py-1">mJy</th>
                  {d.normalised && <th className="px-2 py-1">× comp</th>}
                  <th className="px-2 py-1">Excl.</th>
                </tr>
              </thead>
              <tbody>
                {d.points.map((p) => (
                  <tr key={p.epoch} className="border-t border-border">
                    <td className="px-2 py-0.5">
                      {p.epoch} · {label(p.epoch)}
                    </td>
                    <td className="px-2 py-0.5">
                      {p.flux === null ? '—' : `${fmt(p.flux)} ± ${fmt(p.flux_err ?? 0)}`}
                    </td>
                    {d.normalised && (
                      <td className="px-2 py-0.5">{p.rel === null ? '—' : `${fmt(p.rel)} ± ${fmt(p.rel_err ?? 0)}`}</td>
                    )}
                    <td className={cn('px-2 py-0.5', p.many_excluded && 'text-foreground')}>
                      {p.n_excluded ?? '?'}/{p.n_aperture}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </>
    )
  }

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-card p-3" aria-label="Light curve">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium">
          Light curve{d?.measurable ? ` · ${detector} · ${d.label}` : ''}
          {live && <span className="font-normal text-muted-foreground"> (current stack)</span>}
        </h3>
        <Button size="icon-xs" variant="ghost" aria-label="Close light curve" onClick={onClose}>
          <X />
        </Button>
      </div>
      {body}
    </section>
  )
}
