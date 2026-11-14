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
reason_table: { "<code>": { key, label, rank? } }   # see "Blank-pixel reasons"; the web reads labels from here
detectors: { D1: [lo_um, hi_um], ... }
epochs: [{
  id: "A", label: "May 2025", mjd_start, mjd_end, year_mid, n_images,
  n_masked,                          # exposures that loaded but were entirely blank (e.g. fully saturated)
  predicted_px: { x, y },            # where the target should be, screen pixels
  frames: {
    D1..D6: { n_images, n_masked, pixels: [[...]], flagged_fraction,
              reasons?: ["0001100...", ...],   # why null pixels are null, see below
              other_flags?: { PLANE: [[row, col], ...] } },   # plane behind each other_flag pixel
    ALL:    { ... }                  # median over every detector = default view
  }
}]

motion?: {                           # only for targets with a known proper motion (planetx/motion.py)
  measurable, measured_px | null, predicted_px,   # first -> last epoch, screen px
  detector | null, window_px: 5, min_snr: 3, from_epoch, to_epoch,
  search: { x, y, radius_px },                     # search disc shared by all epochs
  reason: null | "saturated" | "ambiguous" | "faint" | "no_data",
  centroids: [{ epoch, x, y, peak_x, peak_y, snr }],   # chosen detector, screen px
  null_test: null | { x, y, measured_px, detector, measurable, min_snr, reason }   # stationary reference star, measured in `detector` (ALL/D1-D3)
}

lightcurve?: {                       # every target (planetx/photometry.py; `planetx annotate` or build)
  method: "fixed_aperture", units: "mJy",
  centre: { x, y },                  # mean predicted position: ONE aperture centre for all epochs
  track_px,                          # predicted shift first -> last epoch (a mover drifts across the aperture)
  excluded_warn_frac: 0.1,           # many_excluded = n_excluded / n_aperture > this (UI: hollow point)
  comp_min_snr: 10,
  detectors: {                       # D1..D6 only; ALL is not measured (mixes detectors differently per epoch)
    D1: { mode: "aperture" | "outer_glow",
          label: "aperture flux" | "outer-glow brightness (core saturated | core flagged | core blank, likely saturated)",
          measurable, reason: null | "core_too_large",
          aperture_px: [r0, r1],     # [0, 2.5] or the outer-glow ring around a blank core
          annulus_px: [r0, r1],      # background ring (median)
          r_core?,                   # outer_glow: radius of the blank core (union over epochs), px
          normalised,                # true: rel = flux / comparison star in the same frame
          comparison: null | { x, y, min_snr },
          points: [{ epoch, mjd, flux | null, flux_err | null, rel | null, rel_err | null,
                     n_aperture, n_excluded | null, n_bg | null, many_excluded }] },
    ...
  }
}

## web/public/data/targets/<id>.spectrum.json   (per-exposure samples, loaded on the first click)
target, size_px, units, wave_unit: "um", wave_origin_px: (size_px - 1) / 2
exposures: [{ epoch, detector, obs_id,
              wave: [l0, dl_dcol, dl_drow],   # um at screen pixel (col,row) = l0 + dl_dcol*(col-o) + dl_drow*(row-o)
              bandwidth,                       # um, at the field centre
              pixels: [[...]],                 # this exposure alone on the grid, row 0 = top, null = blank
              reasons?: ["0102..."],           # same codes as frames (only when something is blank)
              other_flags?: { PLANE: [[row, col], ...] } }]
- wavelength: planetx/spectral.py (WAVE-TAB lookup in each file's WCS-WAVE extension), fitted
  as a plane over the grid (max residual ~1e-6 um).

## web/public/data/manifest.json
{ generated_at, collections[], counts: { <id>: { images, used, epochs } },   # counts merged across partial builds
  reason_table }                                                            # same as in every target file

## Rules
- pixels: row 0 = top (rows already flipped from FITS). null = no data.
- Never NaN (writer uses allow_nan=False).
- A detector with no usable data is omitted, not empty.
- Moving east = moving LEFT on screen.

## Blank-pixel reasons (frames[*].reasons / other_flags, reason_table)
One implementation for curated and live data: `py/src/planetx/reasons.py`. Categories, codes,
labels, priority and planes live in `py/config/sources.toml` `[reasons]` and are published as
`reason_table` (`{code: {key, label, rank}}`, rank 0 = highest priority; code 0 = valid has no
rank). Clients take labels from the table and never hardcode codes, except that **1 = saturated**
is fixed (motion.py, photometry.py and the web depend on it).

`reasons`: one string per row (row 0 = top, same orientation as `pixels`), one digit per pixel.
Current table (priority order):

| code | key | blank because | planes |
|---|---|---|---|
| 0 | valid | (pixel has a value; a flag bit may still be set, e.g. OVERFLOW = onset of nonlinearity) | |
| 1 | saturated | saturated | OVERFLOW (`MSKD0001 = 'Overflow detected during SUR'`) |
| 2 | defect | dead / hot / cold pixel | NONFUNC, HOT, COLD |
| 3 | transient | cosmic ray or onboard processing error | TRANSIENT, SUR_ERROR |
| 4 | persistence | charge left by an earlier bright source | PERSIST |
| 5 | missing | data lost onboard | MISSING_DATA |
| 6 | other_flag | a `[flags].bad` plane in no category above; the plane is named in `other_flags` | (none today) |
| 8 | unexplained | blank, but no mapped plane is set | |
| 7 | not_observed | no exposure's footprint covered the pixel | |

- Plane names and bits are read from each file's FLAGS header (`MSKNnnnn` = name,
  `MSKMnnnn` = 1<<n, `MSKDnnnn` = description). Nothing is hardcoded. Informational planes
  (SOURCE, GHOST*, CROSSTALK, STREAK, ...) are deliberately not mapped: they don't blank pixels,
  and a pixel blank for another reason that carries one is not caused by it.
- Native pixel: the highest-priority category whose plane is set; else unexplained.
- Reprojection: for each reason, an indicator that is NaN on its native pixels goes through the
  same bilinear reprojection as the data, so it blanks exactly the output pixels the data's NaNs
  blank. A blank output pixel inside the footprint takes the highest-priority reason among the
  native pixels in its stencil; outside the footprint it is not_observed. (reproject clamps the
  outer half pixel to the border pixel, so a stencil never runs off the frame: there is no
  separate "edge" reason.)
- Stacking: a stacked pixel is blank only if every exposure is blank there; it takes the
  highest-priority reason over ALL exposures, **including entirely blank ones** that the
  median/mean drops (counted in `n_masked`). So an epoch whose exposures are all masked says why
  (e.g. saturated), never not_observed. not_observed ranks last: one exposure that missed a pixel
  never hides another exposure's reason.
- `reasons` / `other_flags` are omitted when the frame has no blank pixels (or no other_flag
  pixels). A null pixel with no `reasons` (older data) is treated as unexplained.

## Live API: progressive refinement (custom RA/Dec)
Stateless: the server never stores progress. The client carries an opaque `cursor` and keeps
the running sums. (The server caches the plan and finished 25×25 frames under
`cache_dir()` purely as a speed-up; both are rebuilt when missing.)

### GET /target?ra=&dec=  → plan (one SIA query, no pixels, ~3-5 s cold, instant when cached)
Same keys as a target file except `n_used`, plus per-epoch exposures and `refine`:
```
target, grid, units, generated_at, collections[], n_images, detectors, reason_table
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
  frames: { D6: { sum: [[...]], count: [[...]], n_images, n_masked,
                  reasons?: ["..."], other_flags? }, ... },          # DELTAS for this call only
  failed: [{ slot, obs_id, detector, reason }] }]
```
- `sum` / `count`: per-pixel sum of background-subtracted frames and number of valid frames,
  row 0 = top (same orientation as `pixels`). count 0 → sum 0. Never NaN.
- Client: add each delta to its running sums; pixel = sum / count (null where count is 0).
  `ALL` = all detectors pooled (sum of sums / sum of counts).
- `reasons` (delta): per pixel, the highest-priority reason over this call's exposures of that
  detector, fully masked ones included (0 = no blank exposure seen). Fold deltas with the same
  rule (lower `reason_table` rank wins, 0 = identity; `ALL` folds every detector) and show the
  folded code where count is 0; a pixel with count 0 and nothing folded is not_observed. This is
  `reasons.merge` (py) = the same result as the curated stacking rule. `n_masked` = exposures
  in this delta that were entirely blank (also listed in `failed` as `all_masked`).
- GET /target carries `reason_table`.
- So live frames are a **mean**, not the median used by curated builds (a median can't be
  accumulated from deltas). Bad pixels are already masked by FLAGS before summing.
- `failed[].reason`: `no_coverage` (window outside the image), `all_masked` (every pixel
  flagged), `unavailable` (archive kept failing; given up after 2 no-progress calls),
  `bad_file`, `http_NNN`, `error`. A failed exposure still counts towards depth (it is a
  settled slot), so depth stays equal; it just contributes nothing.
- `exposures` (per epoch): per-exposure samples for the spectrum,
  `[{ slot, obs_id, detector, wave, bandwidth, pixels, reasons?, other_flags? }]` (same meaning
  as the spectrum sidecar). Only exposures with usable pixels and a wavelength are listed.
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

### POST /photometry  `{ pixel_scale_arcsec, epochs: [{ id, mjd_start, mjd_end, predicted_px: {x, y}, frames: { D1..D6: { pixels, reasons? } } }] }`
The light curve (same object as `lightcurve` above) of frames the client already holds: a live
view's mean-stacked frames. `/target/refine` returns only per-call deltas and the server keeps no
state, so the client sends its stack. Pure computation, no archive access. 422 = frames not
square / not all the same size / unknown frame key (max 16 epochs, 64 x 64 px).
