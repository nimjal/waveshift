// Guided tour for first-time visitors: five one-sentence steps, each pointing at one control.
// Shown once (remembered in localStorage), skippable at any time, replayed from the "?" button.
//
// Rules it follows:
//   - the blink image is never covered or dimmed, and keeps playing;
//   - the page stays usable: the dimming layer ignores the pointer, so the highlighted control
//     can be clicked, and the Difference step moves on when Difference is actually chosen;
//   - on phones the text is a small sheet at the bottom of the screen, with the control scrolled
//     into view above it, because a tooltip anchored to the control often lands off-screen.
//
// A step points at the element carrying data-tour="<target>" (set in App.tsx and BlinkPlayer.tsx).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import { markGuideSeen } from '@/lib/prefs'
import type { ViewMode } from '@/lib/render'
import { cn } from '@/lib/utils'

type Target = 'image' | 'epochs' | 'view' | 'picker'

interface Step {
  target: Target
  /** one sentence, under about 15 words */
  text: string
  /** 'cycle': Next appears after one full blink cycle. 'difference': moves on when the view
   * becomes Difference. */
  until?: 'cycle' | 'difference'
}

const STEPS: Step[] = [
  { target: 'image', text: 'The same patch of sky, photographed months apart. Watch what moves.', until: 'cycle' },
  { target: 'epochs', text: 'These are the visit dates. Each frame is the sky on that day.' },
  { target: 'image', text: 'The crosshair predicts where this star should be. It moves with it.' },
  { target: 'view', text: 'Tap Difference to see only what changed.', until: 'difference' },
  { target: 'picker', text: 'Try another star, or type any name or coordinates.' },
]

const PHONE_QUERY = '(max-width: 639px)'
const DIM = 0.5 // opacity of the layer over everything except the image and the current control
const PAD = 6 // px of breathing room around the highlighted control
const GAP = 12 // px between the control and the tooltip
const CARD_WIDTH = 320

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function boxOf(target: Target): Box | null {
  const el = document.querySelector(`[data-tour="${target}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
}
const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Where the tooltip goes on a wide screen: next to the control, inside the window, and not on
 * top of the image. Falls back to the bottom-right corner. */
function placeCard(target: Box | null, image: Box | null, cardH: number): { left: number; top: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const corner = { left: vw - CARD_WIDTH - 16, top: vh - cardH - 16 }
  if (!target) return corner
  const midX = Math.min(Math.max(target.x + target.w / 2 - CARD_WIDTH / 2, 16), vw - CARD_WIDTH - 16)
  const midY = Math.min(Math.max(target.y + target.h / 2 - cardH / 2, 16), vh - cardH - 16)
  const options = [
    { left: midX, top: target.y + target.h + GAP }, // below
    { left: midX, top: target.y - cardH - GAP }, // above
    { left: target.x + target.w + GAP, top: midY }, // right
    { left: target.x - CARD_WIDTH - GAP, top: midY }, // left
  ]
  const fits = (p: { left: number; top: number }) =>
    p.left >= 8 &&
    p.top >= 8 &&
    p.left + CARD_WIDTH <= vw - 8 &&
    p.top + cardH <= vh - 8 &&
    !(image && overlaps({ x: p.left, y: p.top, w: CARD_WIDTH, h: cardH }, image))
  return options.find(fits) ?? corner
}

interface Props {
  open: boolean
  onClose: () => void
  /** the player's current view: the Difference step watches it */
  mode: ViewMode
  /** how long one pass through all epochs takes at the default speed, ms */
  cycleMs: number
}

export function Tour({ open, onClose, mode, cycleMs }: Props) {
  if (!open) return null
  return createPortal(<TourSteps onClose={onClose} mode={mode} cycleMs={cycleMs} />, document.body)
}

function TourSteps({ onClose, mode, cycleMs }: Omit<Props, 'open'>) {
  const [step, setStep] = useState(0)
  /** the view when the current step began: Difference only counts if the visitor chose it now */
  const [modeAtStart, setModeAtStart] = useState(mode)
  const [cycleSeen, setCycleSeen] = useState(false)
  const [boxes, setBoxes] = useState<{ target: Box | null; image: Box | null }>({ target: null, image: null })
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches)
  const [cardH, setCardH] = useState(120)
  const card = useRef<HTMLDivElement>(null)
  const s = STEPS[step]
  const last = step === STEPS.length - 1

  const finish = () => {
    markGuideSeen()
    onClose()
  }
  const go = (next: number) => {
    setModeAtStart(mode)
    setStep(next)
  }

  // bring the step's control into view, then keep its outline on it while the page scrolls,
  // resizes or re-renders (cheap: two getBoundingClientRect calls per frame, only during the tour)
  useEffect(() => {
    document.querySelector(`[data-tour="${s.target}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    let raf = 0
    const tick = () => {
      const next = { target: boxOf(s.target), image: boxOf('image') }
      setBoxes((prev) => (sameBox(prev.target, next.target) && sameBox(prev.image, next.image) ? prev : next))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [s.target])

  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY)
    const onChange = () => setPhone(mq.matches)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      markGuideSeen()
      onClose()
    }
    mq.addEventListener('change', onChange)
    window.addEventListener('keydown', onKey)
    return () => {
      mq.removeEventListener('change', onChange)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // step 1: Next appears once the blink has gone round once
  useEffect(() => {
    const t = window.setTimeout(() => setCycleSeen(true), cycleMs)
    return () => window.clearTimeout(t)
  }, [cycleMs])

  // Difference step: move on shortly after the visitor switches to Difference
  const choseDifference = s.until === 'difference' && mode === 'diff' && modeAtStart !== 'diff'
  useEffect(() => {
    if (!choseDifference) return
    const t = window.setTimeout(() => {
      setModeAtStart('diff')
      setStep((n) => n + 1)
    }, 1200)
    return () => window.clearTimeout(t)
  }, [choseDifference])

  // Next is held back while a step waits for something. A step whose control isn't on the page
  // (or whose action is already done) never waits, so the tour can't get stuck.
  const waiting =
    (s.until === 'cycle' && !cycleSeen) ||
    (s.until === 'difference' && !!boxes.target && modeAtStart !== 'diff')

  const waitingText = !waiting ? '' : s.until === 'cycle' ? 'Watch one full blink…' : choseDifference ? 'That’s it.' : 'Try it'

  useLayoutEffect(() => {
    const h = card.current?.offsetHeight
    if (h && h !== cardH) setCardH(h)
  }, [step, phone, waitingText, cardH])

  const { target, image } = boxes
  const holes = [target, s.target === 'image' ? null : image].filter((b): b is Box => !!b)
  const pos = phone ? null : placeCard(target, image, cardH)

  return (
    <>
      {/* dim everything except the image and the current control; clicks pass through */}
      <svg className="pointer-events-none fixed inset-0 z-40 size-full" aria-hidden>
        <defs>
          <mask id="tour-holes">
            <rect width="100%" height="100%" fill="white" />
            {holes.map((b, i) => (
              <rect key={i} x={b.x - PAD} y={b.y - PAD} width={b.w + 2 * PAD} height={b.h + 2 * PAD} rx={8} fill="black" />
            ))}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="black" opacity={DIM} mask="url(#tour-holes)" />
        {target && (
          <rect
            x={target.x - PAD}
            y={target.y - PAD}
            width={target.w + 2 * PAD}
            height={target.h + 2 * PAD}
            rx={8}
            fill="none"
            stroke="#22d3ee"
            strokeWidth={2}
          />
        )}
      </svg>

      <div
        ref={card}
        role="dialog"
        aria-label="Guided tour"
        style={pos ? { left: pos.left, top: pos.top, width: CARD_WIDTH } : undefined}
        className={cn(
          'fixed z-50 flex flex-col gap-3 border border-border bg-card p-4 text-card-foreground shadow-lg',
          phone ? 'inset-x-0 bottom-0 rounded-t-lg pb-[max(1rem,env(safe-area-inset-bottom))]' : 'rounded-lg',
        )}
      >
        <p className="text-sm leading-snug" aria-live="polite">
          {s.text}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {step + 1} / {STEPS.length}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {!last && (
              <Button size="sm" variant="ghost" onClick={finish}>
                Skip
              </Button>
            )}
            {waiting ? (
              <span className="px-2 text-xs text-muted-foreground">{waitingText}</span>
            ) : last ? (
              <Button size="sm" onClick={finish}>
                Done
              </Button>
            ) : (
              <Button size="sm" onClick={() => go(step + 1)}>
                Next
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
