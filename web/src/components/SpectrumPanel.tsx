// Brightness against wavelength for one sky pixel, one point per exposure.
//
// SPHEREx images through linear variable filters: across a detector the passband shifts
// smoothly, so every exposure sees a given sky position at a different wavelength. Sampling the
// same pixel in every exposure of the current view therefore traces out a spectrum. The
// wavelength of each sample comes from that exposure's spectral WCS (planetx/spectral.py),
// shipped as a plane over the display grid.
//
// Colour = epoch. Up to three epochs share one plot (the first three categorical slots, which
// validate all-pairs for a scatter); more epochs are drawn as small multiples instead, because
// no fourth hue stays distinguishable from all the others for colour-blind readers.

import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { type Pick, type Sample, sampleSpectrum } from '@/lib/spectrum'
import type { SpectrumData, TargetData } from '@/lib/types'

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)']
const SHAPES = ['circle', 'square', 'triangle'] as const

function niceTicks(lo: number, hi: number, count = 5): number[] {
  const span = hi - lo || 1
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? raw
  const out: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Number(t.toPrecision(10)))
  return out
}

function fmt(v: number): string {
  const a = Math.abs(v)
  if (a !== 0 && (a < 0.01 || a >= 1000)) return v.toExponential(1)
  return Number(v.toPrecision(3)).toString()
}

function Marker({ shape, x, y, fill }: { shape: (typeof SHAPES)[number]; x: number; y: number; fill: string }) {
  const ring = { fill, stroke: 'var(--card)', strokeWidth: 2, paintOrder: 'stroke' } as const
  if (shape === 'square') return <rect x={x - 4} y={y - 4} width={8} height={8} rx={1} {...ring} />
  if (shape === 'triangle') return <path d={`M${x},${y - 5} L${x + 5},${y + 4} L${x - 5},${y + 4} Z`} {...ring} />
  return <circle cx={x} cy={y} r={4} {...ring} />
}

const M = { top: 12, right: 14, bottom: 40, left: 54 }

interface PlotProps {
  samples: Sample[]
  xDomain: [number, number]
  yDomain: [number, number]
  colorOf: (epoch: number) => string
  shapeOf: (epoch: number) => (typeof SHAPES)[number]
  label: (s: Sample) => string
  units: string
  ariaLabel: string
}

function Plot({ samples, xDomain, yDomain, colorOf, shapeOf, label, units, ariaLabel }: PlotProps) {
  const [hover, setHover] = useState<number | null>(null)
  // drawn at the container's real width so text and markers keep their pixel sizes on phones
  const wrap = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(560)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const H = Math.round(Math.min(300, Math.max(200, W * 0.5)))
  const iw = W - M.left - M.right
  const ih = H - M.top - M.bottom
  const sx = (v: number) => M.left + ((v - xDomain[0]) / (xDomain[1] - xDomain[0])) * iw
  const sy = (v: number) => M.top + (1 - (v - yDomain[0]) / (yDomain[1] - yDomain[0])) * ih
  const xt = niceTicks(xDomain[0], xDomain[1], W < 400 ? 5 : 6).filter((t) => t >= xDomain[0] && t <= xDomain[1])
  const yt = niceTicks(yDomain[0], yDomain[1], 5).filter((t) => t >= yDomain[0] && t <= yDomain[1])

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - box.left) / box.width) * W
    const py = ((e.clientY - box.top) / box.height) * H
    let best: number | null = null
    let bd = 14 ** 2 // hit radius (viewBox units) larger than the 4px mark
    samples.forEach((s, i) => {
      const d = (sx(s.lam) - px) ** 2 + (sy(s.value) - py) ** 2
      if (d < bd) {
        bd = d
        best = i
      }
    })
    setHover(best)
  }
  const h = hover !== null ? samples[hover] : null

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
        {/* recessive grid + axes */}
        {yt.map((t) => (
          <g key={`y${t}`}>
            <line x1={M.left} x2={W - M.right} y1={sy(t)} y2={sy(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={M.left - 6} y={sy(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px]">
              {fmt(t)}
            </text>
          </g>
        ))}
        {yDomain[0] < 0 && yDomain[1] > 0 && (
          <line x1={M.left} x2={W - M.right} y1={sy(0)} y2={sy(0)} stroke="var(--muted-foreground)" strokeWidth={1} />
        )}
        {xt.map((t) => (
          <g key={`x${t}`}>
            <line x1={sx(t)} x2={sx(t)} y1={H - M.bottom} y2={H - M.bottom + 4} stroke="var(--muted-foreground)" />
            <text x={sx(t)} y={H - M.bottom + 16} textAnchor="middle" className="fill-muted-foreground text-[11px]">
              {fmt(t)}
            </text>
          </g>
        ))}
        <line x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} stroke="var(--muted-foreground)" />
        <text x={M.left + iw / 2} y={H - 4} textAnchor="middle" className="fill-muted-foreground text-[11px]">
          Wavelength (µm)
        </text>
        <text
          transform={`translate(12 ${M.top + ih / 2}) rotate(-90)`}
          textAnchor="middle"
          className="fill-muted-foreground text-[11px]"
        >
          {units}
        </text>
        {samples.map((s, i) => (
          <Marker key={i} shape={shapeOf(s.epoch)} x={sx(s.lam)} y={sy(s.value)} fill={colorOf(s.epoch)} />
        ))}
        {h && (
          <circle cx={sx(h.lam)} cy={sy(h.value)} r={7} fill="none" stroke="var(--foreground)" strokeWidth={1.5} />
        )}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute top-1 right-1 rounded-md border border-border bg-popover px-2 py-1 font-mono text-xs text-popover-foreground shadow"
          role="status"
        >
          {label(h)}
          <br />
          {h.lam.toFixed(3)} µm · {fmt(h.value)} {units.replace(/^.*\((.*)\)$/, '$1')}
        </div>
      )}
    </div>
  )
}

interface Props {
  data: TargetData
  spectrum: SpectrumData | null | 'loading' | 'error'
  pick: Pick
  onClose: () => void
}

export function SpectrumPanel({ data, spectrum, pick, onClose }: Props) {
  const result = useMemo(
    () => (spectrum && typeof spectrum === 'object' ? sampleSpectrum(spectrum, data, pick) : null),
    [spectrum, data, pick],
  )
  const live = data.target.kind === 'custom'
  const units = 'Brightness (MJy/sr)'
  const where = pick.follow
    ? 'the target, following its predicted position in each epoch'
    : `pixel x ${pick.c}, y ${pick.r}`

  let body
  if (spectrum === 'loading') body = <p className="text-sm text-muted-foreground">Loading the per-exposure samples…</p>
  else if (spectrum === 'error') body = <p className="text-sm text-destructive">Couldn't load the spectrum samples.</p>
  else if (!spectrum || !result) {
    body = (
      <p className="text-sm text-muted-foreground">
        {live
          ? 'No per-exposure samples yet: they arrive with the refinement (this server may be too old to send them).'
          : 'This build has no spectrum samples for this target. Rebuild it with `just build`.'}
      </p>
    )
  } else if (result.samples.length === 0) {
    body = <p className="text-sm text-muted-foreground">No exposure has a usable value at this pixel.</p>
  } else {
    const { samples, skipped } = result
    const lams = samples.map((s) => s.lam)
    const vals = samples.map((s) => s.value)
    const xDomain: [number, number] = [Math.min(0.7, ...lams), Math.max(5.1, ...lams)]
    let lo = Math.min(0, ...vals)
    let hi = Math.max(...vals)
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.08
    lo -= lo < 0 ? pad : 0
    hi += pad
    const yDomain: [number, number] = [lo, hi]
    const eps = data.epochs
    const facet = eps.length > SERIES.length
    const count = (i: number) => samples.filter((s) => s.epoch === i).length
    const label = (s: Sample) => `${eps[s.epoch].id} · ${eps[s.epoch].label} · ${s.detector}`
    const left = skipped.map((x) => `${x.n} ${x.label.toLowerCase()}`)

    body = (
      <>
        {facet ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {eps.map((e, i) => (
              <figure key={e.id} className="flex flex-col gap-1">
                <figcaption className="text-xs text-muted-foreground">
                  Epoch {e.id} · {e.label} · {count(i)} exposures
                </figcaption>
                <Plot
                  samples={samples.filter((s) => s.epoch === i)}
                  xDomain={xDomain}
                  yDomain={yDomain}
                  colorOf={() => SERIES[0]}
                  shapeOf={() => 'circle'}
                  label={label}
                  units={units}
                  ariaLabel={`Spectrum at ${where}, epoch ${e.label}`}
                />
              </figure>
            ))}
          </div>
        ) : (
          <>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Epochs">
              {eps.map((e, i) => (
                <li key={e.id} className="flex items-center gap-1.5">
                  <svg viewBox="-6 -6 12 12" className="size-3" aria-hidden>
                    <Marker shape={SHAPES[i]} x={0} y={0} fill={SERIES[i]} />
                  </svg>
                  {e.id} · {e.label} ({count(i)})
                </li>
              ))}
            </ul>
            <Plot
              samples={samples}
              xDomain={xDomain}
              yDomain={yDomain}
              colorOf={(i) => SERIES[i]}
              shapeOf={(i) => SHAPES[i]}
              label={label}
              units={units}
              ariaLabel={`Spectrum at ${where}: ${samples.length} exposures`}
            />
          </>
        )}
        <p className="text-xs text-muted-foreground">
          {samples.length} exposures, one point each: background-subtracted single-pixel brightness. Each exposure sees
          this spot through a different part of SPHEREx's graded filter, so at a different wavelength (read from that
          exposure's spectral WCS). It is a single 6″ pixel, so a neighbouring star that shares it adds its light too.
          {left.length > 0 && <> Left out: {left.join(', ')}.</>}
        </p>
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Show samples as a table</summary>
          <div className="mt-2 max-h-60 overflow-auto rounded border border-border">
            <table className="w-full font-mono">
              <thead className="sticky top-0 bg-muted text-left">
                <tr>
                  <th className="px-2 py-1">µm</th>
                  <th className="px-2 py-1">MJy/sr</th>
                  <th className="px-2 py-1">Epoch</th>
                  <th className="px-2 py-1">Det</th>
                  <th className="hidden px-2 py-1 sm:table-cell">Exposure</th>
                </tr>
              </thead>
              <tbody>
                {samples.map((s, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-2 py-0.5">{s.lam.toFixed(3)}</td>
                    <td className="px-2 py-0.5">{fmt(s.value)}</td>
                    <td className="px-2 py-0.5">{eps[s.epoch].id}</td>
                    <td className="px-2 py-0.5">{s.detector}</td>
                    <td className="hidden px-2 py-0.5 break-all sm:table-cell">{s.obs_id}</td>
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
    <section className="flex flex-col gap-2 rounded-md border border-border p-3" aria-label="Spectrum">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium">Spectrum at {where}</h3>
        <Button size="icon-xs" variant="ghost" aria-label="Close spectrum" onClick={onClose}>
          <X />
        </Button>
      </div>
      {body}
    </section>
  )
}
