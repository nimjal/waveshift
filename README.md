# Waveshift: SPHEREx sky blink viewer (NASA Space Apps 2026, Planet X)

Enter any RA/Dec and get a time-lapse of NASA SPHEREx sky images across observation epochs, so
objects that move or change brightness, like nearby stars and brown dwarfs, stand out against the fixed background.

- **Live demo:** https://waveshift-4billion.vercel.app
- **Demo video:** `TODO: video URL`
- **Repo:** https://github.com/nimjal/waveshift

## What it does

- **Curated targets** are built ahead of time into static JSON (`web/public/data/`) and load instantly.
- **Any other position** is refined progressively by the API: `GET /target` returns the plan
  (epochs + ordered exposures, a few seconds), then the page calls `POST /target/refine` repeatedly
  (≤ 15 s each) and re-renders after every call. First frames show within ~10 s; every epoch is
  always at the same depth. Pixels are read with HTTP range requests straight from the IRSA files.
  The server is stateless (the client carries a cursor); plans and finished frames are cached
  under the cache dir as a speed-up. See `docs/schema.md` → "Live API".
- The player blinks between epochs on a 25 × 25 px grid (6.15″/px, north up, east left). For each
  detector, one brightness stretch is shared by all epochs, so the blink shows real changes rather
  than rescaling. Views:
  - **Blink:** each epoch's image.
  - **Difference:** each epoch minus the per-pixel median of all epochs. A mover shows amber where
    it is now and blue where it was.
  - **Detector:** `ALL` (median of every detector) or one of D1–D6 (0.75–5.0 µm).
- A cyan reticle marks where the target should be in each epoch, predicted from its proper motion.
- **Measured vs predicted motion** (curated targets with a known proper motion): under the title,
  e.g. "Measured shift 1.65 px vs 1.31 px predicted · reference star 0.03 px". A centroid estimate
  that doesn't depend on the prediction: in one search disc shared by all epochs (centred on the
  track's midpoint, radius = half the track + 3 px), each epoch's brightest pixel is found and a
  5×5 px intensity-weighted centroid is taken around it, in the reddest detector where the target
  has peak S/N ≥ 3 in every epoch (`py/src/planetx/motion.py`). Saturated, too-faint or ambiguous
  targets (the peak jumps more than the predicted step + 2 px) show "not measurable". The same
  measurement runs on an isolated stationary star in the field, picked automatically in whichever of
  ALL / D1 / D2 / D3 it is brightest and measurable in every epoch. Its "shift" should be ~0: it is
  a bias check (does the method invent motion for a star that doesn't move?), not the error bar on
  the target's shift. The reference star is usually much brighter than the target, so the target's
  own centroid noise is larger.
- **Spectrum on the fly:** click the target (or any pixel) to plot brightness against wavelength,
  one point per exposure, coloured by epoch. SPHEREx's linear variable filters mean each exposure
  sees a sky position at a different wavelength; each sample's wavelength comes from that
  exposure's spectral WCS (`WAVE-TAB` lookup in the `WCS-WAVE` extension,
  `py/src/planetx/spectral.py`). Clicking within 1.5 px of the reticle follows the target's
  predicted track. Blank (saturated / flagged / no-data) samples are left out and counted. Curated
  targets load the samples from `targets/<id>.spectrum.json` (1.6–2.8 MB, fetched on the first
  click); live views get them with each refine call.
- **Light curve:** brightness per epoch in the selected detector (D1–D6), shown by default for
  variable stars and on request for any target (`py/src/planetx/photometry.py`). Fixed-aperture
  photometry on the stacked frames: one aperture (2.5 px radius) at the same spot in every epoch,
  background = median of a 5–8 px ring, error bars from that ring's scatter (a lower bound: no
  photon noise of the star). Blank pixels are left out and counted; a point with more than 10% of
  its aperture blank is drawn hollow. When an isolated comparison star in the same frame is
  measurable at S/N ≥ 10 in every epoch, the curve is relative to it (target ÷ star); otherwise it
  is the raw flux in mJy, labelled "not normalised". A saturated core (R Dra) is measured as a
  ring just outside the blank core and labelled "outer-glow brightness (core saturated)", never as
  the star's total flux. `ALL` has no light curve: it mixes detectors differently in each epoch.
  Curated targets carry it in their JSON; live views send their current stack to
  `POST /photometry`.
- **Search by name:** the custom tab resolves names ("Mira", "M42", "WISE 0855") on the server
  (`GET /resolve`): curated aliases first, then CDS Sesame. The position is moved by its proper
  motion to the grid epoch (2025.9) before the live query starts.
- **Shareable links:** the URL holds the view: `?target=<id>` or `?ra=<deg>&dec=<deg>`, plus
  optional `&det=ALL|D1…D6`, `&view=blink|diff`, `&stretch=linear|sqrt|asinh`. Opening a link
  restores the view (custom coordinates start the live query automatically); invalid parameters
  fall back to defaults with a notice. A new target pushes a history entry (Back/Forward work);
  detector/view/stretch changes replace it. **Copy link** copies the current URL. Old
  `#target=…` links still work.
- **Embed:** add `&embed=1` to any link to get only the player (blink/difference, epoch labels,
  compass, scale bar) and a small "Open in Waveshift" link, for an `<iframe>`. All other link
  parameters still apply; a bad parameter shows a one-line notice instead of a silent fallback.
- **Download GIF:** exports the current blink (detector, view, stretch, reticle) as a looping
  350 × 350 px GIF with the epoch label burned into each frame, in the browser (~20 KB for 3
  epochs). The encoder is a small built-in one (`web/src/lib/gif.ts`), loaded on first use.
- **Sky context:** an Aladin Lite panel showing the same patch of sky at higher resolution in
  2MASS (default), AllWISE or DSS colour, 5′ across, with the 2.56′ blink field outlined (north
  up, east left) and the target marked. A Gaia DR3 layer (G < 18, the 200 brightest at most) can
  be switched on and off; clicking a source shows its source ID, G magnitude and proper motion.
  Gaia positions are for epoch 2016.0, so a fast mover appears offset from its marker; a line
  joins the two. On screens 1280 px and wider the panel sits beside the blink viewer at the same
  size. On smaller screens it is a collapsed bar under the viewer and loads only when opened. If a
  service can't be reached the panel says so and nothing else is affected (see Data sources).
- **First visit:** a five-step guided tour, one sentence per step, that points at the image, the
  visit dates, the crosshair, the Difference toggle and the target picker. The image is never
  covered and keeps blinking; the Difference step moves on when Difference is actually chosen.
  Skip is always there, the tour shows once per browser, and the "?" button replays it. On phones
  the text is a sheet at the bottom of the screen. Detector, stretch, blink speed and the
  per-epoch numbers sit under **More controls**, folded by default. Under the player, a freshness line gives the curated build date
  from `manifest.json` and the IRSA collections live views query.

**When the API is unreachable:** curated targets keep working because they are static files. The
"Custom RA/Dec" tab checks `GET /health` and shows "Server not responding". Submitting a position
then shows "Couldn't reach the server", with **Try again** and **Explore curated targets** buttons.
A production build made without `VITE_API_URL` disables the custom tab and says the custom
feature is unavailable on that site.

## Required challenge targets

Counts come from `web/public/data/manifest.json` (built 2026-11-14). "Images" is the number of
SPHEREx images covering the position; "used" is how many downloaded and aligned successfully.
"Predicted shift" is computed from the catalogue proper motion (`predicted_px` in each target file).
"Measured" is the centroid estimate described above (`motion` in each target file), first to last epoch.

| Target | Kind | Epochs | Images (used) | What to look for |
| --- | --- | --- | --- | --- |
| Barnard's Star | nearby star | 3: Sep 2025, Apr 2026, Sep 2026 | 358 (358) | **Motion.** Predicted shift ≈ 1.7 px upward (north); measured 1.68 px (D6); no isolated reference star in the field. |
| Epsilon Indi B | brown dwarf pair | 4: May 2025, Oct 2025, Apr 2026, Sep 2026 | 458 (458) | **Motion.** Predicted shift ≈ 1.0 px toward lower left (south-east); measured 0.98 px (D6); reference star (4, 4) 0.05 px in D2. Epoch D has no D1/D4 data. |
| WISE 0855-0714 | brown dwarf | 3: May 2025, Nov 2025, May 2026 | 258 (258) | **Motion.** Predicted shift ≈ 1.3 px to the right (west); measured 1.65 px vs 1.31 predicted (D6), within the ~0.3 px centroid noise at its D6 S/N (4.3 in epoch A); overlaps a static background star by epoch C, which shows in its spectrum below 2.5 µm. Bias check: reference star (15, 5) 0.03 px in D2. Only `spherex_dr1` had images. |
| RW Aurigae | variable star | 3: Sep 2025, Mar 2026, Sep 2026 | 335 (335) | **Brightness change.** It shouldn't move (predicted shift < 0.01 px; measured 0.08 px, D6; reference star (8, 7) 0.02 px in D1). |
| R Draconis | variable star | 3: Jun 2025, Nov 2025, Jun 2026 | 539 (539) | **Brightness change.** It shouldn't move (predicted shift < 0.01 px). Saturated core: shift not measurable. |

Positions and proper motions are in `py/config/targets.toml`.

## How it works

```
                    py/config/sources.toml, py/config/targets.toml
                                        │
                              IRSA SIA query (query.py)
                                        │
             ┌──────────────────────────┴──────────────────────────┐
   CURATED (just build, cli.py)                       LIVE (just api, api.py + live.py)
   pipeline.build_target                              GET /target  → plan (exposure order)
   IRSA cutout service (cutouts.py)                   POST /target/refine, repeated:
   → subtract ZODI, mask FLAGS                        HTTP range reads of the IRSA files (remote.py)
   → reproject onto the 25×25 grid (stack.py)         → mask FLAGS (ZODI skipped, see below)
   → MEDIAN per epoch per detector                    → same 25×25 grid (stack.window_to_grid)
             │                                        → sums + counts; the browser shows the MEAN,
             ▼                                          re-rendered after every call
   web/public/data/*.json (static)                                     │
             └──────────────────────────┬──────────────────────────────┘
                                        ▼
                      Vite + React frontend (web/, just web)
```

The two paths share the grid, the flag mask and the JSON shape (`docs/schema.md`), but not the
combine step:

- **Curated:** cutouts from IRSA's cutout service, reprojected onto the grid, then the **median**
  of every exposure in an epoch (per detector). The median rejects outliers (cosmic rays, a
  satellite trail in one exposure).
- **Live:** pixels are read with HTTP range requests straight from the IRSA files (`remote.py`),
  put on the same grid with the same flags, and accumulated as running sums and counts, so the
  page shows the **mean**. That is what lets it refine progressively without the server keeping
  state; a median can't be updated incrementally from sums.
- **ZODI** (zodiacal light model): the curated build subtracts the `ZODI` extension. The live path
  skips it: over a 2.5′ window it is nearly constant and the per-frame background subtraction
  removes it anyway (measured effect < 3e-5 of the frame noise), and skipping it saves two round
  trips per exposure.

The curated targets are plain static files, so they work on any static host even with no backend
running. The API handles every other position on the sky.

## Run locally

**Prerequisites:** [uv](https://docs.astral.sh/uv/), Python 3.14 (pinned in
`py/.python-version`; `uv python install 3.14` if you don't have it), Node.js with npm, and
[just](https://github.com/casey/just).

```sh
# install
(cd py && uv sync)          # Python deps, including the api and dev groups
(cd web && npm install)     # frontend deps
```

Then use one terminal for each command, run from the repo root:

```sh
just build   # optional: rebuild curated targets into web/public/data (already committed)
just api     # FastAPI backend on http://localhost:7860 (/health, GET /target?ra=&dec=, POST /target/refine)
just web     # Vite dev server, http://localhost:5173 by default
```

- `just build` queries IRSA and downloads cutouts into `py/data/cache/` (git-ignored). To build a subset, run
  `cd py && uv run python -m planetx.cli build barnard r-dra`.
- `just lint` runs oxlint on the frontend.
- `cd py && uv run python -m planetx.cli annotate` recomputes derived fields (`motion`,
  `lightcurve`) of the built target files without touching the archive (manifest.json is left alone).
- `just build` reuses cutouts already in `py/data/cache/`, so a rebuild doesn't re-download them.

**Environment variables**

| Variable | Used by | Effect |
| --- | --- | --- |
| `VITE_API_URL` | frontend | API base URL. In dev it falls back to `http://localhost:7860`. It is baked in at build time. If it is unset in a production build, custom coordinates are disabled. |
| `PLANETX_ROOT` | backend | Overrides root detection (the directory holding `config/` and `data/`; `py/` by default). |

**Static build for self-hosting:** `cd web && VITE_API_URL=https://your-api.example npm run build`
writes `web/dist/`. It uses relative paths (`base: './'`), so it can be served from any directory.

## Data sources

- **SPHEREx images:** the IRSA Simple Image Access service (via `astroquery`'s `Irsa.query_sia`)
  on collections `spherex_dr1` and `spherex_qr3` (`config/sources.toml`). Only science products
  are used. Curated builds take cutouts from each image's IRSA `access_url` with `center`/`size`
  parameters, subtract the `ZODI` extension and mask bad pixels using the `FLAGS` extension. Live
  views read the same files with HTTP range requests and apply the same `FLAGS` mask (no ZODI, see
  "How it works").
- **SIMBAD:** positions and proper motions for the curated targets were taken from SIMBAD
  (Harvard mirror) and written into `py/config/targets.toml`. `just build` does not query SIMBAD when
  those values are present. Custom positions are assumed to have zero proper motion.
- **CDS Sesame** (Strasbourg, falling back to the Harvard mirror): name lookup for the custom tab,
  called by the API (`GET /resolve`), never from the browser. Curated target names are matched
  locally first.
- **Aladin Lite** (CDS, Strasbourg; GPL-3): the "Sky context" panel, loaded at run time only when
  the panel is open and never bundled into this repo. The viewer is the CDS team's `aladin-lite` npm build, pinned to 3.8.2 (latest stable)
  and loaded by the browser from jsDelivr (`cdn.jsdelivr.net/npm/aladin-lite@3.8.2`); the
  `aladin.cds.unistra.fr/AladinLite/api/v3/latest/` script in the Aladin docs returned 404 in
  Nov 2026. Imagery: the CDS **2MASS colour** HiPS (`CDS/P/2MASS/color`, J/H/Ks, default) and
  **AllWISE colour** HiPS (`CDS/P/allWISE/color`, W1/W2/W4) and **DSS2 colour** HiPS
  (`CDS/P/DSS2/color`), loaded from IRSA's mirror of them
  (`irsa.ipac.caltech.edu/data/hips/CDS/...`), because the CDS hosts didn't serve them at the time.
  Aladin's usage logging is turned off. If any of this is unreachable the panel says so and
  nothing else is affected.
- **Gaia DR3** (VizieR table `I/355/gaiadr3`): the source overlay in the "Sky context" panel. The
  browser queries VizieR's `asu-tsv` service, the Harvard mirror (`vizier.cfa.harvard.edu`) first
  and CDS Strasbourg second, for sources with G < 18 in a 6′ box.
- No other external services are used. Everything above except Aladin Lite and the Gaia overlay
  is called by the pipeline or the API, not by the browser.

**Acknowledgements:** This project uses data from the SPHEREx mission, obtained from the
NASA/IPAC Infrared Science Archive (IRSA), and the SIMBAD database, operated at CDS, Strasbourg,
France. The sky context panel uses Aladin Lite (Boch & Fernique 2014, ASPC 485, 277) developed
at CDS, the 2MASS (Skrutskie et al. 2006) and AllWISE (Wright et al. 2010; Mainzer et al.
2011) surveys and the Digitized Sky Survey (STScI) as HiPS, the VizieR catalogue access tool
(CDS), and data from the European Space Agency mission Gaia, processed by the Gaia Data
Processing and Analysis Consortium (DPAC). This is an independent project and is not endorsed by NASA.

## Verification

`notebooks/tests.ipynb` is a self-contained test sheet for the `planetx` package. It runs
**96 checks in 17 sections**:

| Section | Checks | Covers |
| --- | --- | --- |
| imports | 9 | every module imports |
| config | 5 | repo root, config parsing, curated targets have explicit coordinates |
| targets | 8 | proper-motion propagation (RA ÷ cos Dec, RA wrap, negative Δt), no SIMBAD call when values are explicit |
| query | 8 | merge/dedupe across collections (fake IRSA), epoch splitting, detector ranges |
| cutouts | 8 | cutout URL, cache key, retries on 503, 404 fails fast, non-FITS rejected, parallel fetch |
| stack | 8 | target grid, flag-bit masking, alignment of rotated input, off-footprint → NaN, epoch median |
| export | 2 | row flip, NaN → null, writer rejects NaN, failed write leaves the old file intact |
| pipeline | 5 | output shape, star lands on `predicted_px`, per-group cap, detector filter, no-images case |
| cli | 2 | writes and merges the index; one failing target doesn't stop the rest |
| api | 8 | /health without config, refine plan (slot order, equal per-detector depth, cache), refine deltas + reason codes, stall → progress guarantee, 422/409 errors, input validation, upstream failure → 502, CORS incl. POST preflight |
| live | 3 | real IRSA query and cutout for WISE 0855, live SIMBAD lookup |
| live-e2e | 1 | full `build_target` for WISE 0855, plus a saved epoch plot |
| reasons | 4 | blank-pixel reasons on real cached cutouts (R Dra saturated, WISE 0855 valid), built JSON |
| resolve | 4 | Sesame XML parsing (hit, proper motion, not found), curated aliases + propagation to 2025.9, `GET /resolve` 200/404/502/422, live Sesame (Mira ≈ 34.84, −2.98) |
| motion | 6 | synthetic mover, stationary star with a predicted shift (the bias case), saturated/faint/ambiguous/single-epoch, null test on a stationary star in the WISE 0855 field (< 0.3 px), WISE 0855 within 0.5 px of predicted, R Dra not measurable, old vs new method printed side by side |
| spectral | 6 | synthetic WAVE-TAB (uneven control points, cutout CRPIX, range, PC rejected), exact match with wcslib on real cutouts (SIP excluded), WISE 0855 wavelengths 0.75–5.0 µm (±0.01) and increasing with detector, sidecar wavelengths inside each exposure's SIA band, refine samples, live range-read == IRSA cutout |
| photometry | 9 | import, synthetic constant star flat within errors (χ²), star brightened 2× measured ~2×, comparison star cancels a frame-wide 30% offset, saturated core → outer-glow ring + label, off-centre saturated core in the aperture (a moving star) → outer-glow, excluded pixels counted, RW Aur and R Dra finite with the right labels (stored == recomputed), `POST /photometry` == function, 422 on bad frames |

The 6 checks named `LIVE …` need network access; set `RUN_LIVE = False` to skip them. The `reasons`,
`motion`, `spectral`, `photometry` checks read cached cutouts and the built JSON in `web/public/data`. To run it,
use the `py/.venv` kernel (`ipykernel` is in the `dev` group) and choose Restart & Run All. Results
are written to `notebooks/test_output/` (`report.md`, `results.json`, `wise0855_epochs.png`;
git-ignored). Last full run (2026-11-14, `RUN_LIVE = True`, ~4 min): 96 of 96 passed, including `LIVE build_target (WISE 0855)`, which now also computes the light curve.

## Use of AI

The frontend, API wiring and much of the implementation were built with Claude Code assisting. The data layer (planetx, including remote.py and the spectral wavelength code) was reviewed, verified against IRSA's cutout service and notebook tests, and written by hand. No AI-generated images, logos or NASA branding are used.

## License

MIT, see `LICENSE`.
