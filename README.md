# Planet X — SPHEREx sky blink viewer

Enter any RA/Dec and get a time-lapse of NASA SPHEREx sky images across observation epochs, so
objects that move or change brightness, like nearby stars and brown dwarfs, stand out against the fixed background.

- **Live demo:** `TODO: demo URL`
- **Demo video:** `TODO: video URL`

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
  e.g. "Measured shift 1.46 px vs 1.31 px predicted". A centroid estimate: intensity-weighted
  centre of a 3×3 px window around each epoch's predicted position, in the reddest detector where
  the target has peak S/N ≥ 3 in every epoch (`py/src/planetx/motion.py`). Saturated or too-faint
  targets show "not measurable".
- **Spectrum on the fly:** click the target (or any pixel) to plot brightness against wavelength,
  one point per exposure, coloured by epoch. SPHEREx's linear variable filters mean each exposure
  sees a sky position at a different wavelength; each sample's wavelength comes from that
  exposure's spectral WCS (`WAVE-TAB` lookup in the `WCS-WAVE` extension,
  `py/src/planetx/spectral.py`). Clicking within 1.5 px of the reticle follows the target's
  predicted track. Blank (saturated / flagged / no-data) samples are left out and counted. Curated
  targets load the samples from `targets/<id>.spectrum.json` (1.6–2.8 MB, fetched on the first
  click); live views get them with each refine call.
- **Search by name:** the custom tab resolves names ("Mira", "M42", "WISE 0855") on the server
  (`GET /resolve`): curated aliases first, then CDS Sesame. The position is moved by its proper
  motion to the grid epoch (2025.9) before the live query starts.
- **Shareable links:** the URL holds the view: `?target=<id>` or `?ra=<deg>&dec=<deg>`, plus
  optional `&det=ALL|D1…D6`, `&view=blink|diff`, `&stretch=linear|sqrt|asinh`. Opening a link
  restores the view (custom coordinates start the live query automatically); invalid parameters
  fall back to defaults with a notice. A new target pushes a history entry (Back/Forward work);
  detector/view/stretch changes replace it. **Copy link** copies the current URL. Old
  `#target=…` links still work.

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
| Barnard's Star | nearby star | 3: Sep 2025, Apr 2026, Sep 2026 | 358 (358) | **Motion.** Predicted shift ≈ 1.7 px upward (north); measured 1.42 px (D6). |
| Epsilon Indi B | brown dwarf pair | 4: May 2025, Oct 2025, Apr 2026, Sep 2026 | 458 (458) | **Motion.** Predicted shift ≈ 1.0 px toward lower left (south-east); measured 0.97 px (D6). Epoch D has no D1/D4 data. |
| WISE 0855-0714 | brown dwarf | 3: May 2025, Nov 2025, May 2026 | 258 (258) | **Motion.** Predicted shift ≈ 1.3 px to the right (west); measured 1.46 px (D6). Only `spherex_dr1` had images. By epoch C it sits on a static blue star, which shows in its spectrum below 2.5 µm. |
| RW Aurigae | variable star | 3: Sep 2025, Mar 2026, Sep 2026 | 335 (335) | **Brightness change.** It shouldn't move (predicted shift < 0.01 px; measured 0.09 px, D6). |
| R Draconis | variable star | 3: Jun 2025, Nov 2025, Jun 2026 | 539 (534) | **Brightness change.** It shouldn't move (predicted shift < 0.01 px). Saturated core: shift not measurable. |

Positions and proper motions are in `config/targets.toml`.

## How it works

```
                 config/sources.toml, config/targets.toml
                                  │
                     ┌────────────┴────────────┐
                     │  planetx (py/src/)      │   IRSA SIA query → cutouts → reproject
                     │  pipeline.build_target  │   onto a common grid → median per epoch
                     └─────┬──────────────┬────┘
                           │              │
            just build     │              │   just api  (FastAPI, :7860)
            (cli.py)       ▼              ▼   GET /target?ra=&dec=   (api.py)
     web/public/data/*.json             + POST /target/refine (progressive)
                           │              │
                           └──────┬───────┘
                                  ▼
                   Vite + React frontend (web/, just web)
```

Both paths call the same `build_target` function and return the same JSON shape, described in
`docs/schema.md`. The curated targets are plain static files, so they work on any static host
even with no backend running. The API handles every other position on the sky.

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
- `cd py && uv run python -m planetx.cli annotate` recomputes derived fields (`motion`) of the built
  target files without touching the archive.
- `just build` reuses cutouts already in the cache dir. The full set used for the committed files lives
  in `<repo>/data/cache`; point `PLANETX_CACHE_DIR` there to rebuild without re-downloading.

**Environment variables**

| Variable | Used by | Effect |
| --- | --- | --- |
| `VITE_API_URL` | frontend | API base URL. In dev it falls back to `http://localhost:7860`. It is baked in at build time. If it is unset in a production build, custom coordinates are disabled. |
| `PLANETX_ROOT` | backend | Overrides repo-root detection (where `config/` and `data/` live). |

**Static build for self-hosting:** `cd web && VITE_API_URL=https://your-api.example npm run build`
writes `web/dist/`. It uses relative paths (`base: './'`), so it can be served from any directory.

## Data sources

- **SPHEREx images:** the IRSA Simple Image Access service (via `astroquery`'s `Irsa.query_sia`)
  on collections `spherex_dr1` and `spherex_qr3` (`config/sources.toml`). Only science products
  are used. Cutouts come from each image's IRSA `access_url` with `center`/`size` parameters. The
  pipeline subtracts the `ZODI` extension and masks bad pixels using the `FLAGS` extension.
- **SIMBAD:** positions and proper motions for the curated targets were taken from SIMBAD
  (Harvard mirror) and written into `config/targets.toml`. `just build` does not query SIMBAD when
  those values are present. Custom positions are assumed to have zero proper motion.
- **CDS Sesame** (Strasbourg, falling back to the Harvard mirror): name lookup for the custom tab,
  called by the API (`GET /resolve`), never from the browser. Curated target names are matched
  locally first.
- No other external services are used.

**Acknowledgements:** This project uses data from the SPHEREx mission, obtained from the
NASA/IPAC Infrared Science Archive (IRSA), and the SIMBAD database, operated at CDS, Strasbourg,
France. This is an independent project and is not endorsed by NASA.

## Verification

`notebooks/tests.ipynb` is a self-contained test sheet for the `planetx` package. It runs
**85 checks in 16 sections**:

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
| motion | 4 | synthetic mover, saturated/faint/single-epoch cases, WISE 0855 ≈ 1.45 vs 1.31 px, R Dra not measurable |
| spectral | 6 | synthetic WAVE-TAB (uneven control points, cutout CRPIX, range, PC rejected), exact match with wcslib on real cutouts (SIP excluded), WISE 0855 wavelengths 0.75–5.0 µm (±0.01) and increasing with detector, sidecar wavelengths inside each exposure's SIA band, refine samples, live range-read == IRSA cutout |

The 6 checks named `LIVE …` need network access; set `RUN_LIVE = False` to skip them. The `reasons`,
`motion`, `spectral` checks read cached cutouts and the built JSON in `web/public/data`. To run it,
use the `py/.venv` kernel (`ipykernel` is in the `dev` group) and choose Restart & Run All. Results
are written to `notebooks/test_output/` (`report.md`, `results.json`, `wise0855_epochs.png`;
git-ignored). Last full run, live checks included (2026-11-14): 85 of 85 passed.

## Not yet done

- Proper motion for custom positions: name search moves the field to the object's current position,
  but the live view still assumes zero proper motion (the reticle marks the field centre).
- Gaia DR3 overlay (planned, waiting on review of the motion and spectrum work).
- Frontend tests (the UI was checked with scripted headless-Chromium runs, not committed tests).
- Demo and video URLs above are placeholders.

## Use of AI

The frontend, API wiring and much of the implementation were built with Claude Code. The data layer
(planetx, including remote.py and the spectral wavelength code) was reviewed, verified against IRSA's
cutout service and notebook tests, and partly rewritten by hand. No AI-generated images, logos or NASA
branding are used.

## License

MIT, see `LICENSE`.
