import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Crosshair, Download, LineChart, Loader2, Pause, Play } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { availableFrameKeys, NO_FRAME_RGB, renderFrames, type Stretch, type ViewMode } from '@/lib/render'
import { drawReasonPatterns, reasonAt, reasonsOf, reasonsPresent, reasonText, swatchBackground } from '@/lib/reasons'
import { LightCurvePanel } from '@/components/LightCurvePanel'
import { SpectrumPanel } from '@/components/SpectrumPanel'
import type { Pick } from '@/lib/spectrum'
import type { SpectrumData, TargetData } from '@/lib/types'
import { DEFAULT_DISPLAY, type DisplayState } from '@/lib/url'
import { cn } from '@/lib/utils'

/** CSS pixels per sky pixel at full size (25 px grid → 500 px canvas). */
const CELL = 20

const MARKER_COLOR = '#22d3ee' // cyan-400
const TRACK_COLOR = 'rgba(34, 211, 238, 0.45)'

function detectorLabel(key: string, data: TargetData): string {
  if (key === 'ALL') return 'All detectors (stacked)'
  const range = data.detectors[key]
  return range ? `${key} · ${range[0].toFixed(2)}–${range[1].toFixed(2)} µm` : key
}

function formatValue(v: number): string {
  const a = Math.abs(v)
  if (a !== 0 && (a < 0.01 || a >= 1000)) return v.toExponential(1)
  return v.toPrecision(3)
}

const rgb = (c: readonly number[]) => `rgb(${c.join(',')})`

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  data: TargetData,
  epochIdx: number,
  showMarker: boolean,
  cell = CELL,
) {
  const size = data.grid.size_px
  const full = size * cell

  if (showMarker) {
    // faint track through every epoch's predicted position
    const pts = data.epochs.map((e) => [(e.predicted_px.x + 0.5) * cell, (e.predicted_px.y + 0.5) * cell] as const)
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
    const gap = cell * 1.4
    const len = cell * 1.1
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
  const barPx = (arcsec / data.grid.pixel_scale_arcsec) * cell
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
  /** detector / view / stretch: owned by the app so they can live in the URL */
  display: DisplayState
  onDisplayChange: (next: DisplayState) => void
  /** per-exposure samples for the click-to-spectrum panel: already in memory (live) or
   * fetched on the first click (curated sidecar file) */
  spectrum?: { live: SpectrumData } | { load: () => Promise<SpectrumData | null> }
  /** ?embed=1: only the player (canvas, epochs, blink/difference) */
  embed?: boolean
  /** shown beside the canvas on wide screens and under it otherwise (the sky-context panel) */
  aside?: ReactNode
}

/** GIF export: sky pixel -> 14 px, so a 25 px grid is a 350 px square (small file, still legible). */
const GIF_CELL = 14

/** Draw every epoch offscreen at GIF_CELL and encode a looping GIF (encoder lazy-loaded). */
async function exportGif(
  data: TargetData,
  canvases: (HTMLCanvasElement | null)[],
  frameKey: string,
  mode: ViewMode,
  stretch: Stretch,
  showMarker: boolean,
  fps: number,
) {
  const { encodeGif } = await import('@/lib/gif')
  const size = data.grid.size_px
  const full = size * GIF_CELL
  const cv = document.createElement('canvas')
  cv.width = full
  cv.height = full
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = false
  const frames: ImageData[] = []
  data.epochs.forEach((e, i) => {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, full, full)
    const src = canvases[i]
    if (src) {
      ctx.drawImage(src, 0, 0, full, full)
      drawReasonPatterns(ctx, e.frames[frameKey], reasonsOf(data), size, GIF_CELL)
    } else {
      ctx.fillStyle = rgb(NO_FRAME_RGB)
      ctx.fillRect(0, 0, full, full)
      ctx.fillStyle = '#fff'
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`No ${frameKey} data in this epoch`, full / 2, full / 2)
    }
    drawOverlay(ctx, data, i, showMarker, GIF_CELL)
    // burned-in labels: epoch (top left, like the player) and what is shown (bottom right)
    ctx.font = 'bold 13px ui-monospace, monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const label = `${e.id} · ${e.label}`
    ctx.fillStyle = 'rgba(0,0,0,0.65)'
    ctx.fillRect(6, 6, ctx.measureText(label).width + 12, 22)
    ctx.fillStyle = '#fff'
    ctx.fillText(label, 12, 10)
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    const what = `${data.target.name} · ${frameKey} · ${mode === 'diff' ? 'difference' : 'blink'} · ${stretch}`
    ctx.fillStyle = 'rgba(0,0,0,0.65)'
    const tw = ctx.measureText(what).width
    ctx.fillRect(full - tw - 14, full - 22, tw + 8, 18)
    ctx.fillStyle = '#fff'
    ctx.fillText(what, full - 10, full - 7)
    ctx.textBaseline = 'alphabetic'
    frames.push(ctx.getImageData(0, 0, full, full))
  })
  const blob = encodeGif(frames, 1000 / fps)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `waveshift-${data.target.id}-${frameKey}-${mode}.gif`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(a.href), 10000)
  return blob.size
}

/** Outline the picked pixel (or, when following the target, its position this epoch). */
function drawPick(ctx: CanvasRenderingContext2D, data: TargetData, epochIdx: number, pick: Pick) {
  const p = data.epochs[epochIdx].predicted_px
  const r = pick.follow ? Math.round(p.y) : pick.r
  const c = pick.follow ? Math.round(p.x) : pick.c
  ctx.save()
  ctx.strokeStyle = '#000'
  ctx.lineWidth = 4
  ctx.strokeRect(c * CELL - 1, r * CELL - 1, CELL + 2, CELL + 2)
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.strokeRect(c * CELL - 1, r * CELL - 1, CELL + 2, CELL + 2)
  ctx.restore()
}

export function BlinkPlayer({ data, display, onDisplayChange, spectrum: spectrumProp, embed = false, aside }: Props) {
  const spectrum = embed ? undefined : spectrumProp
  const frameKeys = useMemo(() => availableFrameKeys(data), [data])
  const nEpochs = data.epochs.length

  const [epochIdx, setEpochIdx] = useState(0)
  const [playing, setPlaying] = useState(nEpochs > 1)
  const [fps, setFps] = useState(1.5)
  const [showMarker, setShowMarker] = useState(true)
  // "More controls" starts open when the link asks for a non-default detector or stretch
  const [showMore, setShowMore] = useState(() => display.det !== DEFAULT_DISPLAY.det || display.stretch !== DEFAULT_DISPLAY.stretch)
  const [pick, setPick] = useState<Pick | null>(null)
  const [loaded, setLoaded] = useState<SpectrumData | null | 'loading' | 'error'>(null)
  // light curve: open by default for variable stars, on request for anything else
  const [showLc, setShowLc] = useState(() => !embed && /variable/i.test(data.target.kind))
  const [gif, setGif] = useState<'idle' | 'working' | 'error' | number>('idle')
  const onGif = () => setGif('working')
  const spectrumData = spectrum && 'live' in spectrum ? spectrum.live : loaded

  // A requested detector this target doesn't have (yet: live views fetch D6/D5 first) is
  // shown as the default instead; the request is kept, so it applies once it arrives.
  const detMissing = !frameKeys.includes(display.det)
  const frameKey = detMissing ? (frameKeys[0] ?? 'ALL') : display.det
  const { mode, stretch } = display
  const setFrameKey = (det: string) => onDisplayChange({ ...display, det })
  const setMode = (m: ViewMode) => onDisplayChange({ ...display, mode: m })
  const setStretch = (st: Stretch) => onDisplayChange({ ...display, stretch: st })

  const canvasRef = useRef<HTMLCanvasElement>(null)

  const rendered = useMemo(() => renderFrames(data, frameKey, mode, stretch), [data, frameKey, mode, stretch])

  // GIF export runs in an effect (not the click handler) so the memoised frames stay memoised
  useEffect(() => {
    if (gif !== 'working') return
    let cancelled = false
    exportGif(data, rendered.canvases, frameKey, mode, stretch, showMarker, fps).then(
      (bytes) => !cancelled && setGif(bytes),
      () => !cancelled && setGif('error'),
    )
    return () => {
      cancelled = true
    }
  }, [gif, data, rendered, frameKey, mode, stretch, showMarker, fps])

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
      drawReasonPatterns(ctx, data.epochs[epochIdx].frames[frameKey], reasonsOf(data), size, CELL)
    } else {
      ctx.fillStyle = rgb(NO_FRAME_RGB)
      ctx.fillRect(0, 0, full, full)
      ctx.fillStyle = '#fff'
      ctx.font = '15px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`No ${frameKey} data in this epoch`, full / 2, full / 2)
    }
    drawOverlay(ctx, data, epochIdx, showMarker)
    if (pick) drawPick(ctx, data, epochIdx, pick)
  }, [data, rendered, epochIdx, showMarker, frameKey, pick])

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
  const table = reasonsOf(data)
  const present = reasonsPresent(frame, table, data.grid.size_px)

  // hover readout: which sky pixel is under the pointer, and its value or blank reason
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null)
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const n = data.grid.size_px
    const c = Math.floor(((e.clientX - box.left) / box.width) * n)
    const r = Math.floor(((e.clientY - box.top) / box.height) * n)
    setHover(r >= 0 && c >= 0 && r < n && c < n ? { r, c } : null)
  }
  // click: spectrum of that pixel. Clicking within 1.5 px of the reticle of a target with a
  // known proper motion follows the target instead (each epoch at its own predicted position).
  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const n = data.grid.size_px
    const fx = ((e.clientX - box.left) / box.width) * n - 0.5
    const fy = ((e.clientY - box.top) / box.height) * n - 0.5
    const c = Math.round(fx)
    const r = Math.round(fy)
    if (!spectrum || r < 0 || c < 0 || r >= n || c >= n) return
    const p = data.epochs[epochIdx].predicted_px
    const moves = data.target.pmra !== 0 || data.target.pmdec !== 0
    const follow = moves && Math.hypot(fx - p.x, fy - p.y) <= 1.5
    setPick({ r, c, follow })
    if (spectrum && 'load' in spectrum && (loaded === null || loaded === 'error')) {
      setLoaded('loading')
      spectrum.load().then(
        (d) => setLoaded(d),
        () => setLoaded('error'),
      )
    }
  }

  let hoverText: string | null = null
  if (hover && frame) {
    const v = frame.pixels[hover.r]?.[hover.c]
    const why = reasonAt(frame, table, hover.r, hover.c)
    hoverText = `x ${hover.c}, y ${hover.r} · ${
      why === null && typeof v === 'number' ? `${formatValue(v)} MJy/sr` : reasonText(frame, why ?? table.unexplained, hover.r, hover.c)
    }`
  }

  return (
    <div className="flex flex-col gap-4">
      {/* canvas, with the aside next to it at the same size on wide screens */}
      <div className={cn(aside && 'grid grid-cols-1 gap-4 xl:grid-cols-2 xl:items-start')}>
      <div className="mx-auto w-full" style={{ maxWidth: full }}>
        <div className="relative" data-tour="image">
          <canvas
            ref={canvasRef}
            className="block aspect-square w-full rounded-md border border-border bg-black"
            role="img"
            aria-label={`${data.target.name}, epoch ${epoch.label}, ${detectorLabel(frameKey, data)}`}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(null)}
            onClick={onCanvasClick}
            style={{ cursor: spectrum ? 'crosshair' : undefined }}
          />
          <div className="pointer-events-none absolute top-2 left-2 rounded bg-black/60 px-2 py-1 font-mono text-sm text-white">
            {epoch.id} · {epoch.label}
          </div>
          {hoverText && (
            <div className="pointer-events-none absolute right-2 bottom-2 max-w-[70%] rounded bg-black/70 px-2 py-1 text-right font-mono text-xs text-white">
              {hoverText}
            </div>
          )}
        </div>

        {/* epoch timeline */}
        <div className="mt-3 flex items-center gap-2" data-tour="epochs">
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
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          {spectrum && !pick && (
            <p className="text-xs text-muted-foreground">
              Click the target or any pixel to plot its spectrum from the exposures in this view.
            </p>
          )}
          {!embed && (
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {gif === 'error' && <span className="text-xs text-destructive">GIF export failed</span>}
              {typeof gif === 'number' && (
                <span className="text-xs text-muted-foreground">GIF saved ({Math.round(gif / 1024)} KB)</span>
              )}
              {nEpochs > 1 && (
                <Button size="xs" variant="outline" onClick={onGif} disabled={gif === 'working'}>
                  {gif === 'working' ? <Loader2 className="animate-spin" /> : <Download />} Download GIF
                </Button>
              )}
              {!showLc && nEpochs > 1 && (
                <Button size="xs" variant="outline" onClick={() => setShowLc(true)}>
                  <LineChart /> Light curve
                </Button>
              )}
            </div>
          )}
        </div>
        {nEpochs < 2 && (
          <p className="mt-2 text-sm text-muted-foreground">
            Only one epoch has data here, so there's nothing to blink against yet.
          </p>
        )}
      </div>
      {aside}
      </div>

      {pick && spectrum && (
        <SpectrumPanel data={data} spectrum={spectrumData} pick={pick} onClose={() => setPick(null)} />
      )}

      {showLc && !embed && nEpochs > 1 && (
        <LightCurvePanel
          data={data}
          detector={frameKey}
          onPickDetector={setFrameKey}
          onClose={() => setShowLc(false)}
        />
      )}

      {embed && (
        <ToggleGroup
          type="single"
          variant="outline"
          value={mode}
          onValueChange={(v) => v && setMode(v as ViewMode)}
          className="w-full"
          aria-label="View"
        >
          <ToggleGroupItem value="blink" className="flex-1">
            Blink
          </ToggleGroupItem>
          <ToggleGroupItem value="diff" className="flex-1">
            Difference
          </ToggleGroupItem>
        </ToggleGroup>
      )}

      {/* controls */}
      {!embed && (
        <>
        <div className="flex flex-col gap-2" data-tour="view">
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


        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <label className="flex cursor-pointer items-center gap-2">
            <Switch checked={showMarker} onCheckedChange={setShowMarker} />
            <Crosshair className="size-4" style={{ color: MARKER_COLOR }} />
            Predicted position
          </label>
          {/* only the reasons present in this frame; labels come from the data's reason_table */}
          {present.map((x) => (
            <span key={`${x.key}:${x.label}`} className="flex items-center gap-2 text-muted-foreground">
              <span className="inline-block size-3 rounded-sm border border-border" style={{ background: swatchBackground(x.style) }} />
              {x.label}
            </span>
          ))}
          {mode === 'diff' && (
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="inline-block h-3 w-16 rounded-sm bg-gradient-to-r from-[rgb(60,150,255)] via-black to-[rgb(255,190,60)]" />
              fainter · brighter than the median
            </span>
          )}
        </div>

        {/* detector, stretch, speed and the per-epoch numbers: there for the curious, folded away
            by default so the first screen is the image, the dates and Blink / Difference */}
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="flex cursor-pointer items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn('size-4 transition-transform', showMore && 'rotate-180')} />
          More controls
          <span className="text-xs">· wavelength, stretch, speed</span>
        </button>
        {showMore && (
        <>
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
            {detMissing && frameKeys.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {display.det} has no data here{data.target.kind === 'custom' ? ' yet' : ''}; showing {frameKey}.
              </p>
            )}
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
        </>
        )}
        </>
      )}
    </div>
  )
}
