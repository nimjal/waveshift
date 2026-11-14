# Planet X · SPHEREx Blink (web)

A blink comparator for SPHEREx sky patches. Pick a curated target or enter any RA/Dec, and the
player flips between observation epochs on a canvas, so anything that moves (or changes) stands out.

Vite + React + TypeScript, Tailwind v4, shadcn/ui.

## Run

```sh
npm install
npm run dev          # or `just web` from the repo root
just api             # (optional, repo root) local backend on :7860 for custom coordinates
```

In dev, custom coordinates use `http://localhost:7860` unless `VITE_API_URL` is set.

## Build and self-host

```sh
VITE_API_URL=https://your-api.example.org npm run build
```

`dist/` is fully static and uses relative paths (`base: './'`), so it can be served from any
directory by any static file server. `VITE_API_URL` is baked in at build time. If it's unset in
a production build, the "Custom RA/Dec" tab explains that custom coordinates aren't available,
and curated targets still work.

## Data

- `public/data/targets.json`: the curated list, and `public/data/targets/<id>.json`: one file per
  target (see `docs/schema.md`). Both are written by `just build` in the repo root.
  If `targets.json` is missing the app shows "No curated targets found".
- `GET {VITE_API_URL}/target?ra=&dec=` returns a refinement plan, then `POST {VITE_API_URL}/target/refine`
  returns per-call sum/count deltas until done. `src/lib/live.ts` accumulates them into the same
  per-target shape (see `docs/schema.md` → "Live API").

## Code map

| File | What it does |
| --- | --- |
| `src/lib/api.ts` | **All** network calls: static curated JSON, `/health`, `/target`, `/target/refine`, and error classification |
| `src/lib/types.ts` | Types for the data contract |
| `src/lib/render.ts` | Stretch (linear/sqrt/asinh, shared across epochs), difference images, offscreen canvases |
| `src/lib/coords.ts` | Parses decimal degrees or sexagesimal input |
| `src/components/BlinkPlayer.tsx` | Canvas player: play/pause, speed, epoch strip, detector, view, overlays |
| `src/components/CustomPanel.tsx` | RA/Dec form, elapsed-time progress, cancel, friendly errors |
| `src/components/CuratedList.tsx` | Curated target list (prefetches on hover) |
| `src/App.tsx` | Layout, selection, URL hash (`#target=barnard` or `#ra=..&dec=..`) |

## Viewing notes

- Orientation is north up, east left; rows are drawn exactly as given (row 0 = top).
- One stretch per detector is shared by all epochs, so the blink shows motion, not rescaling.
- **Difference** view: each epoch minus the per-pixel median of all epochs. A mover shows
  amber where it is now and blue where it was.
- The cyan reticle marks `predicted_px` (integer = pixel centre); the dashed line is its track.
- Purple pixels have no data (`null`).
- Keyboard: Space = play/pause, ←/→ = step epochs.
