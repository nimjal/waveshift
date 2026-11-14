// "How to read a blink": a short, dismissible guide for first-time visitors (shown once, then
// remembered in localStorage) and reopenable from the "?" button in the header.

import { useState } from 'react'
import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { markGuideSeen } from '@/lib/prefs'
import { cn } from '@/lib/utils'

const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: 'What the blink shows',
    body: (
      <>
        NASA's SPHEREx telescope photographs the whole sky in infrared, revisiting each spot about every six
        months. The player flips between those visits (epochs A, B, C…) of one small patch, about 2.5′ across.
        Distant stars stay put. Something nearby or moving jumps from frame to frame, and a variable star gets
        brighter or fainter.
      </>
    ),
  },
  {
    title: 'The cyan crosshair',
    body: (
      <>
        The cyan crosshair marks where the target <em>should</em> be in each visit, worked out from its known motion
        across the sky. The dotted line is its path. If the bright dot moves along with the crosshair, you are watching
        it move. For a position you type in, the crosshair just marks the centre.
      </>
    ),
  },
  {
    title: 'Blink or Difference',
    body: (
      <>
        <strong>Blink</strong> shows each visit as it was. <strong>Difference</strong> subtracts the typical image
        of all visits, so only what changed stands out: amber where something is brighter now, blue where it was
        brighter before. A moving object shows as an amber and blue pair. For variable stars, the{' '}
        <strong>light curve</strong> plots the brightness at each visit.
      </>
    ),
  },
  {
    title: 'Detectors, wavelength and spectra',
    body: (
      <>
        SPHEREx sees infrared light from 0.75 to 5 µm with six detectors, D1 (bluest) to D6 (reddest); pick one
        under <strong>Detector / wavelength</strong>. Cold brown dwarfs show up best in D6. <strong>Click</strong>{' '}
        the target or any pixel to plot its spectrum: how bright it is at each wavelength.
      </>
    ),
  },
]

export function Guide({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [step, setStep] = useState(0)
  const close = (o: boolean) => {
    if (!o) {
      markGuideSeen()
      setStep(0)
    }
    onOpenChange(o)
  }
  const last = step === STEPS.length - 1
  const s = STEPS[step]
  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-lg"
          aria-describedby="guide-body"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs text-muted-foreground">
                How to read a blink · {step + 1} of {STEPS.length}
              </p>
              <Dialog.Title className="text-base font-semibold">{s.title}</Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <Button size="icon-xs" variant="ghost" aria-label="Close guide">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <p id="guide-body" className="text-sm leading-relaxed">
            {s.body}
          </p>
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1.5" aria-hidden>
              {STEPS.map((_, i) => (
                <span key={i} className={cn('size-1.5 rounded-full', i === step ? 'bg-primary' : 'bg-muted')} />
              ))}
            </div>
            <div className="flex gap-2">
              {step > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setStep(step - 1)}>
                  Back
                </Button>
              )}
              {last ? (
                <Button size="sm" onClick={() => close(false)}>
                  Start exploring
                </Button>
              ) : (
                <Button size="sm" onClick={() => setStep(step + 1)}>
                  Next
                </Button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
