import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Crosshair, Pause, Play } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { availableFrameKeys, NO_DATA_RGB, renderFrames, type Stretch, type ViewMode } from '@/lib/render'
import type { TargetData } from '@/lib/types'
import { cn } from '@/lib/utils'

/** CSS pixels per sky pixel at full size (25 px grid → 500 px canvas). */
const CELL = 20

const MARKER_COLOR = '#22d3ee' // cyan-400
const TRACK_COLOR = 'rgba(34, 211, 238, 0.45)'

function detectorLabel(key: string, data: TargetData): string {
  if (key === 'ALL') return 'All detectors (median)'
  const range = data.detectors[key]
  return range ? `${key} · ${range[0].toFixed(2)}–${range[1].toFixed(2)} µm` : key
}

function formatValue(v: number): string {
  const a = Math.abs(v)
  if (a !== 0 && (a < 0.01 || a >= 1000)) return v.toExponential(1)
  return v.toPrecision(3)
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  data: TargetData,
  epochIdx: number,
  showMarker: boolean,
) {
  const size = data.grid.size_px
  const full = size * CELL

  if (showMarker) {
    // faint track through every epoch's predicted position
    const pts = data.epochs.map((e) => [(e.predicted_px.x + 0.5) * CELL, (e.predicted_px.y + 0.5) * CELL] as const)
    if (pts.length > 1) {
      ctx.strokeStyle = TRACK_COLOR
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.stroke()
      ctx.setLineDash([])
      for (const [x, y] of pts) {
        ctx.fillStyle = TRACK_COLOR
        ctx.beginPath()
        ctx.arc(x, y, 2.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    // reticle with a gap, so it frames the object instead of covering it
    const [x, y] = pts[epochIdx]
    const gap = CELL * 1.4
    const len = CELL * 1.1
    ctx.strokeStyle = MARKER_COLOR
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x - gap - len, y)
    ctx.lineTo(x - gap, y)
    ctx.moveTo(x + gap, y)
    ctx.lineTo(x + gap + len, y)
    ctx.moveTo(x, y - gap - len)
    ctx.lineTo(x, y - gap)
    ctx.moveTo(x, y + gap)
    ctx.lineTo(x, y + gap + len)
    ctx.stroke()
  }

  // scale bar (bottom left): 30 arcsec
  const arcsec = 30
  const barPx = (arcsec / data.grid.pixel_scale_arcsec) * CELL
  const bx = 14
  const by = full - 16
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillRect(bx - 6, by - 20, barPx + 12, 28)
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(bx, by)
  ctx.lineTo(bx + barPx, by)
  ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(`${arcsec}″`, bx + barPx / 2, by - 6)

  // compass (top right): north up, east left
  const ox = full - 16 // corner of the L
  const oy = 50
  const arm = 26
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillRect(ox - arm - 22, oy - arm - 22, arm + 30, arm + 30)
  ctx.strokeStyle = '#fff'
  ctx.fillStyle = '#fff'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(ox, oy)
  ctx.lineTo(ox, oy - arm) // north arm
  ctx.moveTo(ox, oy)
  ctx.lineTo(ox - arm, oy) // east arm
  // arrowheads
  ctx.moveTo(ox - 4, oy - arm + 5)
  ctx.lineTo(ox, oy - arm)
  ctx.lineTo(ox + 4, oy - arm + 5)
  ctx.moveTo(ox - arm + 5, oy - 4)
  ctx.lineTo(ox - arm, oy)
  ctx.lineTo(ox - arm + 5, oy + 4)
  ctx.stroke()
  ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillText('N', ox, oy - arm - 3)
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.fillText('E', ox - arm - 4, oy)
  ctx.textBaseline = 'alphabetic'
}

interface Props {
  data: TargetData
}

export function BlinkPlayer({ data }: Props) {
  const frameKeys = useMemo(() => availableFrameKeys(data), [data])
  const nEpochs = data.epochs.length

  const [epochIdx, setEpochIdx] = useState(0)
  const [playing, setPlaying] = useState(nEpochs > 1)
  const [fps, setFps] = useState(1.5)
  const [frameKey, setFrameKey] = useState(frameKeys[0] ?? 'ALL')
  const [stretch, setStretch] = useState<Stretch>('asinh')
  const [mode, setMode] = useState<ViewMode>('blink')
  const [showMarker, setShowMarker] = useState(true)

  const canvasRef = useRef<HTMLCanvasElement>(null)

  const rendered = useMemo(() => renderFrames(data, frameKey, mode, stretch), [data, frameKey, mode, stretch])

  // advance frames while playing
  useEffect(() => {
    if (!playing || nEpochs < 2) return
    const id = window.setInterval(() => setEpochIdx((i) => (i + 1) % nEpochs), 1000 / fps)
    return () => window.clearInterval(id)
  }, [playing, fps, nEpochs])

  // draw
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const size = data.grid.size_px
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    const full = size * CELL
    canvas.width = full * dpr
    canvas.height = full * dpr
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, full, full)
    const src = rendered.canvases[epochIdx]
    if (src) {
      ctx.drawImage(src, 0, 0, full, full)
    } else {
      ctx.fillStyle = `rgb(${NO_DATA_RGB.join(',')})`
      ctx.fillRect(0, 0, full, full)
      ctx.fillStyle = '#fff'
      ctx.font = '15px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`No ${frameKey} data in this epoch`, full / 2, full / 2)
    }
    drawOverlay(ctx, data, epochIdx, showMarker)
  }, [data, rendered, epochIdx, showMarker, frameKey])

  const step = useCallback(
    (delta: number) => {
      setPlaying(false)
      setEpochIdx((i) => (i + delta + nEpochs) % nEpochs)
    },
    [nEpochs],
  )

  // keyboard: space = play/pause, ←/→ = step, unless a focused control owns that key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (nEpochs < 2 || e.altKey || e.ctrlKey || e.metaKey) return
      const t = e.target instanceof HTMLElement ? e.target : null
      if (t?.isContentEditable) return
      // Space natively activates a focused control (buttons, switches, toggles, tabs);
      // also handling it here would double-toggle.
      if (e.key === ' ' && t?.closest('button, a, input, textarea, select, [role]')) return
      // Arrows belong to controls that navigate with them (tabs, toggle groups, slider, menus, fields).
      const arrowOwner =
        'input, textarea, select, [role="tab"], [role="radio"], [role="slider"], [role="combobox"], [role="listbox"], [role="option"], [role="menu"]'
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && t?.closest(arrowOwner)) return
      if (e.key === ' ') {
        e.preventDefault()
        setPlaying((p) => !p)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        step(1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        step(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nEpochs, step])

  const epoch = data.epochs[epochIdx]
  const frame = epoch.frames[frameKey]
  const [lo, hi] = rendered.range
  const full = data.grid.size_px * CELL

  return (
    <div className="flex flex-col gap-4">
      <div className="mx-auto w-full" style={{ maxWidth: full }}>
        <div className="relative">
          <canvas
            ref={canvasRef}
            className="block aspect-square w-full rounded-md border border-border bg-black"
            role="img"
            aria-label={`${data.target.name}, epoch ${epoch.label}, ${detectorLabel(frameKey, data)}`}
          />
          <div className="pointer-events-none absolute top-2 left-2 rounded bg-black/60 px-2 py-1 font-mono text-sm text-white">
            {epoch.id} · {epoch.label}
          </div>
        </div>

        {/* epoch timeline */}
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPlaying((p) => !p)}
            disabled={nEpochs < 2}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => step(-1)} disabled={nEpochs < 2} aria-label="Previous epoch">
            <ChevronLeft />
          </Button>
          <div className="flex flex-1 gap-1" role="group" aria-label="Epochs">
            {data.epochs.map((e, i) => (
              <button
                key={e.id}
                type="button"
                onClick={() => {
                  setPlaying(false)
                  setEpochIdx(i)
                }}
                aria-pressed={i === epochIdx}
                aria-label={`Epoch ${e.id}, ${e.label}`}
                className={cn(
                  'flex-1 cursor-pointer rounded-md border px-2 py-1 text-xs',
                  i === epochIdx
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted',
                )}
              >
                <span className="font-mono font-semibold">{e.id}</span>
                <span className="ml-1 hidden sm:inline">{e.label}</span>
              </button>
            ))}
          </div>
          <Button variant="ghost" size="icon" onClick={() => step(1)} disabled={nEpochs < 2} aria-label="Next epoch">
            <ChevronRight />
          </Button>
        </div>
        {nEpochs < 2 && (
          <p className="mt-2 text-sm text-muted-foreground">
            Only one epoch has data here, so there's nothing to blink against yet.
          </p>
        )}
      </div>

      {/* controls */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="detector">Detector / wavelength</Label>
          <Select value={frameKey} onValueChange={setFrameKey}>
            <SelectTrigger id="detector" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {frameKeys.map((k) => (
                <SelectItem key={k} value={k}>
                  {detectorLabel(k, data)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label>View</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={mode}
            onValueChange={(v) => v && setMode(v as ViewMode)}
            className="w-full"
          >
            <ToggleGroupItem value="blink" className="flex-1">
              Blink
            </ToggleGroupItem>
            <ToggleGroupItem value="diff" className="flex-1">
              Difference
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Stretch</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={stretch}
            onValueChange={(v) => v && setStretch(v as Stretch)}
            className="w-full"
          >
            <ToggleGroupItem value="linear" className="flex-1">
              Linear
            </ToggleGroupItem>
            <ToggleGroupItem value="sqrt" className="flex-1">
              Sqrt
            </ToggleGroupItem>
            <ToggleGroupItem value="asinh" className="flex-1">
              Asinh
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="speed">Blink speed · {fps.toFixed(1)} frames/s</Label>
          <Slider
            id="speed"
            min={0.5}
            max={6}
            step={0.5}
            value={[fps]}
            onValueChange={([v]) => setFps(v)}
            disabled={nEpochs < 2}
            className="py-2"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <Switch checked={showMarker} onCheckedChange={setShowMarker} />
          <Crosshair className="size-4" style={{ color: MARKER_COLOR }} />
          Predicted position
        </label>
        <span className="flex items-center gap-2 text-muted-foreground">
          <span
            className="inline-block size-3 rounded-sm border border-border"
            style={{ background: `rgb(${NO_DATA_RGB.join(',')})` }}
          />
          No data
        </span>
        {mode === 'diff' && (
          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="inline-block h-3 w-16 rounded-sm bg-gradient-to-r from-[rgb(60,150,255)] via-black to-[rgb(255,190,60)]" />
            fainter · brighter than the median
          </span>
        )}
      </div>

      {/* epoch facts */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted/40 p-3 font-mono text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Epoch</dt>
          <dd>
            {epoch.id} · {epoch.label}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">MJD</dt>
          <dd>
            {epoch.mjd_start.toFixed(1)}–{epoch.mjd_end.toFixed(1)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Images stacked</dt>
          <dd>{frame ? frame.n_images : '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Flagged pixels</dt>
          <dd>{frame ? `${(frame.flagged_fraction * 100).toFixed(1)}%` : '—'}</dd>
        </div>
        <div className="col-span-2 sm:col-span-4">
          <dt className="text-muted-foreground">Display range ({data.units})</dt>
          <dd>
            {formatValue(lo)} … {formatValue(hi)}
          </dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        Keyboard: <kbd className="rounded border px-1">Space</kbd> play/pause,{' '}
        <kbd className="rounded border px-1">←</kbd> <kbd className="rounded border px-1">→</kbd> step epochs.
      </p>
    </div>
  )
}
