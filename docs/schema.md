# Data contract (pipeline → web)

Curated targets are fully precomputed files (below). Custom positions use the live API
(see "Live API: progressive refinement" at the end); the web client folds its responses into
the same per-target shape, so the viewer renders both identically.

## web/public/data/targets.json
[{ id, name, kind, file, n_epochs }]      # display order = array order = order in py/config/targets.toml

## web/public/data/targets/<id>.json
target:   { id, name, kind, ra, dec, pmra, pmdec, ref_epoch }   # mas/yr; position at ref_epoch
grid:     { size_px, pixel_scale_arcsec, center_ra, center_dec, center_epoch,
            orientation: "north up, east left, row 0 = top" }
units:    "MJy/sr (background-subtracted)"
generated_at, collections[], n_images, n_used
detectors: { D1: [lo_um, hi_um], ... }
epochs: [{
  id: "A", label: "May 2025", mjd_start, mjd_end, year_mid, n_images,
  predicted_px: { x, y },            # where the target should be, screen pixels
  frames: {
    D1..D6: { n_images, pixels: [[...]], flagged_fraction,
              reasons?: ["0001100...", ...],   # why null pixels are null, see below
              flags?:   { SUR_ERROR: 12, ... } },
    ALL:    { ... }                  # median over every detector = default view
  }
}]

motion?: {                           # only for targets with a known proper motion (planetx/motion.py)
  measurable, measured_px | null, predicted_px,   # first -> last epoch, screen px
  detector | null, window_px: 5, min_snr: 3, from_epoch, to_epoch,
  search: { x, y, radius_px },                     # search disc shared by all epochs
  reason: null | "saturated" | "ambiguous" | "faint" | "no_data",
  centroids: [{ epoch, x, y, peak_x, peak_y, snr }],   # chosen detector, screen px
  null_test: null | { x, y, measured_px | null, detector, measurable, reason }   # stationary reference star
}

## web/public/data/targets/<id>.spectrum.json   (per-exposure samples, loaded on the first click)
target, size_px, units, wave_unit: "um", wave_origin_px: (size_px - 1) / 2
exposures: [{ epoch, detector, obs_id,
              wave: [l0, dl_dcol, dl_drow],   # um at screen pixel (col,row) = l0 + dl_dcol*(col-o) + dl_drow*(row-o)
              bandwidth,                       # um, at the field centre
              pixels: [[...]],                 # this exposure alone on the grid, row 0 = top, null = blank
              reasons?: ["0102..."] }]         # same codes as frames (only when something is blank)
- wavelength: planetx/spectral.py (WAVE-TAB lookup in each file's WCS-WAVE extension), fitted
  as a plane over the grid (max residual ~1e-6 um).

## web/public/data/manifest.json
{ generated_at, collections[], counts: { <id>: { images, used, epochs } } }   # counts merged across partial builds

## Rules
- pixels: row 0 = top (rows already flipped from FITS). null = no data.
- Never NaN (writer uses allow_nan=False).
- A detector with no usable data is omitted, not empty.
- Moving east = moving LEFT on screen.

## Blank-pixel reasons (frames[*].reasons / flags)
`reasons`: one string per row (row 0 = top, same orientation as `pixels`), one digit per pixel:

| code | meaning |
|---|---|
| 0 | valid (pixel has a value; a flag bit may still be set) |
| 1 | saturated: a plane listed in sources.toml `[flags].saturated` is set (SPHEREx: `OVERFLOW`, header `MSKN0001` / `MSKD0001 = 'Overflow detected during SUR'`) |
| 2 | blanked by another flag: the first plane of `[flags].bad` (in config order) that is set. The names behind a frame's code-2 pixels are listed in `flags` with pixel counts. |
| 3 | no data / reason unknown (outside the exposure footprint, or NaN with no explanatory flag) |

- Plane names and bits are read from each cutout's FLAGS header (`MSKNnnnn` = name,
  `MSKMnnnn` = 1<<n, `MSKDnnnn` = description). Nothing is hardcoded.
- Precedence per native pixel: saturated first, then `bad` in order, then 3.
- Reprojection: each reason's indicator mask goes through the same bilinear reprojection as the
  data; a blank output pixel takes the reason of any blank native pixel in its stencil.
- Stacking: a stacked pixel is blank only if every stacked frame is blank there. If ANY of them
  is code 1, then 1; else if any is 2, then 2; else 3.
- `reasons` and `flags` are omitted when the frame has no blank pixels (or no code-2 pixels).
  A null pixel with no `reasons` (older data) is treated as code 3.

## Live API: progressive refinement (custom RA/Dec)
Stateless: the server never stores progress. The client carries an opaque `cursor` and keeps
the running sums. (The server caches the plan and finished 25×25 frames under
`cache_dir()` purely as a speed-up; both are rebuilt when missing.)

### GET /target?ra=&dec=  → plan (one SIA query, no pixels, ~3-5 s cold, instant when cached)
Same keys as a target file except `n_used`, plus per-epoch exposures and `refine`:
```
target, grid, units, generated_at, collections[], n_images, detectors
epochs: [{ id, label, mjd_start, mjd_end, year_mid, n_images, predicted_px,
           exposures: [{ obs_id, detector }] }]    # ordered: index i = slot i, length = refine.total
refine: { cursor: "<digest>.<depth>.<stalls>", total, slots: ["D6","D5",...], first_batch: 2, done }
```
Exposure order:
- **slots**: one global detector sequence, long wavelength first (D6 D5 D4 D3 D2 D1 D6 D5 …), cold /
  very red objects are brightest in D5-D6. Detector d appears min over epochs of (#exposures of
  d in that epoch) times, so at every depth every epoch has the same number of frames **per
  detector**: equal depth and equal detector mix.
- within a detector: best coverage first = target closest to the image centre (full window,
  away from edges), `obs_id` breaks ties (deterministic).
- `total` = len(slots) (= exposures per epoch when done). Unused exposures beyond the cap are not listed.

### POST /target/refine  `{ ra, dec, cursor, batch_per_epoch }`  (batch 1-12; first call 1-2)
Fetches slots `[depth, depth+batch)` for EVERY epoch, round-robin, 6 parallel workers,
retry with backoff on 429/5xx/timeouts, and returns within ~15 s. Only **whole rounds** are
committed (slot s finished in every epoch), so all epochs always stay at the same depth.
```
cursor, depth, total, done, committed (rounds this call; 0 = no progress, back off and retry),
elapsed_s,
epochs: [{ id,
  frames: { D6: { sum: [[...]], count: [[...]], n_images }, ... },   # DELTAS for this call only
  failed: [{ slot, obs_id, detector, reason }] }]
```
- `sum` / `count`: per-pixel sum of background-subtracted frames and number of valid frames,
  row 0 = top (same orientation as `pixels`). count 0 → sum 0. Never NaN.
- Client: add each delta to its running sums; pixel = sum / count (null where count is 0).
  `ALL` = all detectors pooled (sum of sums / sum of counts).
- So live frames are a **mean**, not the median used by curated builds (a median can't be
  accumulated from deltas). Bad pixels are already masked by FLAGS before summing.
- `failed[].reason`: `no_coverage` (window outside the image), `all_masked` (every pixel
  flagged), `unavailable` (archive kept failing; given up after 2 no-progress calls),
  `bad_file`, `http_NNN`, `error`. A failed exposure still counts towards depth (it is a
  settled slot), so depth stays equal; it just contributes nothing.
- `exposures` (per epoch): per-exposure samples for the spectrum,
  `[{ slot, obs_id, detector, wave, bandwidth, pixels }]` (same meaning as the spectrum sidecar;
  live frames have no `reasons`). Only exposures with usable pixels and a wavelength are listed.
- Errors: 422 bad input or cursor · 409 plan changed (archive updated): restart from GET
  /target · 502 upstream failure. A failed call changes nothing: retry with the same cursor.
- Pixels are read with HTTP range requests straight from the IRSA L2 files (IMAGE rows + RICE
  FLAGS tiles, ~300 KB per exposure). ZODI is not subtracted: over a 2.5′ window it is a
  near-constant that per-frame background subtraction removes (measured < 3e-5 of frame rms).
  Files with an unexpected layout fall back to the IRSA cutout service.

### GET /resolve?name=   → object name to position
Curated target names / aliases first (config values, no network), then CDS Sesame (Strasbourg,
then the Harvard mirror). 404 = not found, 502 = Sesame unreachable, 422 = empty name.
```
{ query, name, source, curated_id | null,
  ra, dec, pmra, pmdec,              # J2000, mas/yr (pmra includes cos dec)
  epoch, ra_epoch, dec_epoch }       # moved by proper motion to the grid epoch: centre the live query here
```
