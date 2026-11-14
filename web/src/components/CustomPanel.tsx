import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, Telescope } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { API_URL, type ApiError, checkApiHealth, validateCoords } from '@/lib/api'
import { parseDec, parseRa } from '@/lib/coords'

export interface LiveProgress {
  /** exposures per epoch so far (equal for every epoch) */
  depth: number
  /** exposures per epoch when fully refined */
  total: number
  /** per-epoch skipped-exposure summaries, e.g. "B: 2 skipped (all masked ×2)" */
  failed: string[]
}

export type CustomRequest =
  | { status: 'idle' }
  | { status: 'planning'; ra: number; dec: number; startedAt: number }
  | { status: 'refining'; ra: number; dec: number; startedAt: number; progress: LiveProgress; retrying?: string }
  | { status: 'stopped'; ra: number; dec: number; progress: LiveProgress; error?: ApiError }
  | { status: 'error'; ra: number; dec: number; error: ApiError }
  | { status: 'done'; ra: number; dec: number; progress: LiveProgress }

interface Props {
  request: CustomRequest
  initialRa?: string
  initialDec?: string
  onSubmit: (ra: number, dec: number) => void
  /** continue a stopped refinement from its cursor */
  onResume: (ra: number, dec: number) => void
  onCancel: () => void
  onShowCurated: () => void
}

const EXAMPLES = [
  { label: 'WISE 0855−0714 (2025.9)', ra: '133.76', dec: '-7.2422' },
  { label: 'Orion Nebula', ra: '83.8221', dec: '-5.3911' },
]

function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [startedAt])
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
}

function fmtElapsed(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}


function errorCopy(err: ApiError): { title: string; body: string } {
  switch (err.kind) {
    case 'not-configured':
      return {
        title: 'Custom coordinates are not available on this site',
        body: 'This build has no backend API configured. The curated targets still work.',
      }
    case 'invalid-input':
      return { title: 'Those coordinates were rejected', body: err.detail ?? err.message }
    case 'network':
      return {
        title: "Couldn't reach the server",
        body: 'The API may be offline or waking up. Try again in a minute, or explore a curated target meanwhile.',
      }
    case 'timeout':
      return {
        title: 'The server took too long to answer',
        body: 'The archive may be busy. Whatever was already fetched is kept; try again or resume in a minute.',
      }
    case 'plan-changed':
      return {
        title: 'The archive changed while refining',
        body: 'New SPHEREx data arrived for this position. Fetch the patch again to start from the new image list.',
      }
    case 'upstream':
      return {
        title: 'The SPHEREx archive request failed',
        body: 'The server could not get images from IRSA for this position. The archive may be busy, or there may be no coverage here yet.',
      }
    case 'bad-response':
    case 'server':
      return { title: 'Something went wrong on the server', body: err.message }
    case 'aborted':
      return { title: 'Request cancelled', body: 'Nothing was fetched yet. Fetch the patch again whenever you like.' }
  }
}

export function CustomPanel({ request, initialRa = '', initialDec = '', onSubmit, onResume, onCancel, onShowCurated }: Props) {
  const [raText, setRaText] = useState(initialRa)
  const [decText, setDecText] = useState(initialDec)
  const [formError, setFormError] = useState<string | null>(null)
  const [health, setHealth] = useState<'checking' | 'up' | 'down' | 'none'>(API_URL ? 'checking' : 'none')

  useEffect(() => {
    if (!API_URL) return
    const ctrl = new AbortController()
    checkApiHealth(ctrl.signal).then((ok) => {
      if (!ctrl.signal.aborted) setHealth(ok ? 'up' : 'down')
    })
    return () => ctrl.abort()
  }, [])

  const loading = request.status === 'planning' || request.status === 'refining'
  const elapsed = useElapsed(loading ? request.startedAt : null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const ra = parseRa(raText)
    const dec = parseDec(decText)
    if (Number.isNaN(ra) || Number.isNaN(dec)) {
      setFormError('Enter RA and Dec as decimal degrees (133.7951, -7.2451) or sexagesimal (08 55 10.8, -07 14 42).')
      return
    }
    const invalid = validateCoords(ra, dec)
    if (invalid) {
      setFormError(invalid)
      return
    }
    setFormError(null)
    onSubmit(ra, dec)
  }

  if (!API_URL) {
    return (
      <Alert>
        <AlertTriangle />
        <AlertTitle>Custom coordinates are not available here</AlertTitle>
        <AlertDescription>
          <p>
            This build has no backend API configured (<code>VITE_API_URL</code>). The curated targets work without it.
          </p>
          <Button variant="link" className="h-auto p-0" onClick={onShowCurated}>
            Browse curated targets →
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Enter any sky position. The server pulls SPHEREx images from the archive a few at a time and stacks them by
        epoch: the <strong className="text-foreground">first frames appear within seconds</strong> and sharpen as more
        exposures arrive. Long-wavelength detectors (D6, D5) come first, where cold objects are brightest.
      </p>

      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ra">RA</Label>
            <Input
              id="ra"
              inputMode="decimal"
              placeholder="133.7951"
              value={raText}
              onChange={(e) => setRaText(e.target.value)}
              disabled={loading}
              aria-invalid={!!formError}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dec">Dec</Label>
            <Input
              id="dec"
              inputMode="decimal"
              placeholder="-7.2451"
              value={decText}
              onChange={(e) => setDecText(e.target.value)}
              disabled={loading}
              aria-invalid={!!formError}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Degrees, or sexagesimal (RA in hours: <code>08 55 10.8</code>, Dec: <code>-07 14 42</code>).
        </p>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <span className="text-muted-foreground">Try:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              disabled={loading}
              className="cursor-pointer text-primary underline-offset-2 hover:underline disabled:opacity-50"
              onClick={() => {
                setRaText(ex.ra)
                setDecText(ex.dec)
                setFormError(null)
              }}
            >
              {ex.label}
            </button>
          ))}
        </div>
        {formError && <p className="text-sm text-destructive">{formError}</p>}

        {/* Distinct keys matter: if React reused one <button> and flipped its type to
            "submit" while the Cancel click was still being dispatched, the click's
            default action would submit the form and immediately restart the request. */}
        {loading ? (
          <Button key="cancel" type="button" variant="outline" onClick={onCancel}>
            {request.status === 'refining' ? 'Stop refining' : 'Cancel'}
          </Button>
        ) : (
          <Button key="submit" type="submit">
            <Telescope /> Fetch this patch
          </Button>
        )}
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={
              health === 'up'
                ? 'size-2 rounded-full bg-emerald-500'
                : health === 'down'
                  ? 'size-2 rounded-full bg-amber-500'
                  : 'size-2 animate-pulse rounded-full bg-muted-foreground'
            }
          />
          {health === 'up' && 'Server online'}
          {health === 'down' && 'Server not responding. It may be asleep and take a moment to wake.'}
          {health === 'checking' && 'Checking server…'}
        </p>
      </form>

      {loading && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2 font-medium">
              <Loader2 className="size-4 animate-spin" />
              {request.status === 'planning' ? 'Planning' : 'Refining'} RA {request.ra.toFixed(4)}, Dec{' '}
              {request.dec >= 0 ? '+' : ''}
              {request.dec.toFixed(4)}
            </span>
            <span className="font-mono tabular-nums">{fmtElapsed(elapsed)}</span>
          </div>
          {request.status === 'planning' ? (
            <>
              <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="absolute inset-y-0 w-1/3 animate-[indeterminate_1.6s_ease-in-out_infinite] rounded-full bg-primary" />
              </div>
              <p className="text-xs text-muted-foreground">Asking the IRSA archive which SPHEREx images cover this spot…</p>
            </>
          ) : (
            <>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{
                    width: `${request.progress.total ? (100 * request.progress.depth) / request.progress.total : 0}%`,
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                refining ·{' '}
                <span className="font-mono tabular-nums">
                  {request.progress.depth}/{request.progress.total}
                </span>{' '}
                exposures per epoch
                {request.progress.depth === 0 && ' · fetching the first frames'}
              </p>
              {request.retrying && <p className="text-xs text-amber-600 dark:text-amber-400">{request.retrying}</p>}
            </>
          )}
        </div>
      )}

      {request.status === 'stopped' && (
        <Alert variant={request.error ? 'destructive' : 'default'}>
          <AlertTriangle />
          <AlertTitle>
            {request.error ? errorCopy(request.error).title : 'Refinement stopped'} at {request.progress.depth}/
            {request.progress.total} exposures per epoch
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <p>
              {request.error
                ? 'What was fetched so far is still shown. Resume to keep sharpening it.'
                : 'The frames so far stay on screen. Resume continues where it left off.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => onResume(request.ra, request.dec)}>
                Resume
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {request.status === 'done' && request.progress.failed.length > 0 && (
        <p className="text-xs text-muted-foreground">Skipped exposures: {request.progress.failed.join('; ')}.</p>
      )}

      {request.status === 'error' && (
        <Alert variant={request.error.kind === 'aborted' ? 'default' : 'destructive'}>
          <AlertTriangle />
          <AlertTitle>{errorCopy(request.error).title}</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <p>{errorCopy(request.error).body}</p>
            {request.error.detail && request.error.kind !== 'invalid-input' && (
              <details className="text-xs">
                <summary className="cursor-pointer">Technical details</summary>
                <code className="mt-1 block break-all whitespace-pre-wrap">
                  {request.error.status ? `HTTP ${request.error.status}: ` : ''}
                  {request.error.detail}
                </code>
              </details>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => onSubmit(request.ra, request.dec)}>
                Try again
              </Button>
              <Button size="sm" onClick={onShowCurated}>
                Explore curated targets instead
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
