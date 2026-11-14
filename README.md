# Planet X — SPHEREx sky blink viewer

Enter any RA/Dec and get a time-lapse of NASA SPHEREx sky images across observation epochs, so
objects that move or change brightness, like nearby stars and brown dwarfs, stand out against the fixed background.

- **Live demo:** `TODO: demo URL`
- **Demo video:** `TODO: video URL`

## What it does

- **Curated targets** are built ahead of time into static JSON (`web/public/data/`) and load instantly.
- **Any other position** is built on demand by the API, which fetches SPHEREx cutouts from IRSA,
  aligns them and stacks them per epoch. A new position can take a few minutes. Live requests use
  at most 4 images per epoch and detector (`[live] max_per_group`; `full=true` uses all of them),
  while curated builds use every image. Results are cached in `data/cache/live/`, so asking for the
  same position again is instant.
- The player blinks between epochs on a 25 × 25 px grid (6.15″/px, north up, east left). For each
  detector, one brightness stretch is shared by all epochs, so the blink shows real changes rather
  than rescaling. Views:
  - **Blink:** each epoch's image.
  - **Difference:** each epoch minus the per-pixel median of all epochs. A mover shows amber where
    it is now and blue where it was.
  - **Detector:** `ALL` (median of every detector) or one of D1–D6 (0.75–5.0 µm).
- A cyan reticle marks where the target should be in each epoch, predicted from its proper motion.
- `#target=<id>` (e.g. `#target=barnard`) links straight to a curated target. `#ra=…&dec=…` opens
  the custom tab with the fields filled in.

**When the API is unreachable:** curated targets keep working because they are static files. The
"Custom RA/Dec" tab checks `GET /health` and shows "Server not responding". Submitting a position
then shows "Couldn't reach the server", with **Try again** and **Explore curated targets** buttons.
A production build made without `VITE_API_URL` disables the custom tab and says the custom
feature is unavailable on that site.

## Required challenge targets

Counts come from `web/public/data/manifest.json` (built 2026-11-14). "Images" is the number of
SPHEREx images covering the position; "used" is how many downloaded and aligned successfully.
"Predicted shift" is computed from the catalogue proper motion (`predicted_px` in each target file).
It is not a measured detection.

| Target | Kind | Epochs | Images (used) | What to look for |
| --- | --- | --- | --- | --- |
| Barnard's Star | nearby star | 3: Sep 2025, Apr 2026, Sep 2026 | 358 (350) | **Motion.** Predicted shift ≈ 1.7 px upward (north). |
| Epsilon Indi B | brown dwarf pair | 4: May 2025, Oct 2025, Apr 2026, Sep 2026 | 458 (454) | **Motion.** Predicted shift ≈ 1.0 px toward lower left (south-east). Epoch D has no D1/D4 data. |
| WISE 0855-0714 | brown dwarf | 3: May 2025, Nov 2025, May 2026 | 258 (258) | **Motion.** Predicted shift ≈ 1.3 px to the right (west). Only `spherex_dr1` had images. |
| RW Aurigae | variable star | 3: Sep 2025, Mar 2026, Sep 2026 | 335 (333) | **Brightness change.** It shouldn't move (predicted shift < 0.01 px). |
| R Draconis | variable star | 3: Jun 2025, Nov 2025, Jun 2026 | 539 (534) | **Brightness change.** It shouldn't move (predicted shift < 0.01 px). |

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
     web/public/data/*.json             same JSON shape, cached in data/cache/live/
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
just api     # FastAPI backend on http://localhost:7860 (/health, /target?ra=&dec=)
just web     # Vite dev server, http://localhost:5173 by default
```

- `just build` queries IRSA and downloads cutouts into `data/cache/`. To build a subset, run
  `cd py && uv run python -m planetx.cli build barnard r-dra`.
- `just lint` runs oxlint on the frontend.

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
- No other external services are used.

**Acknowledgements:** This project uses data from the SPHEREx mission, obtained from the
NASA/IPAC Infrared Science Archive (IRSA), and the SIMBAD database, operated at CDS, Strasbourg,
France. This is an independent project and is not endorsed by NASA.

## Verification

`notebooks/tests.ipynb` is a self-contained test sheet for the `planetx` package. It runs
**63 checks in 12 sections**:

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
| api | 4 | build + cache, input validation, upstream failure → 502, CORS |
| live | 3 | real IRSA query and cutout for WISE 0855, live SIMBAD lookup |
| live-e2e | 1 | full `build_target` for WISE 0855, plus a saved epoch plot |

The first 59 checks run offline against synthetic FITS files and a mocked IRSA. The last 4 need
network access; set `RUN_LIVE = False` to skip them. To run it, use the `py/.venv` kernel
(`ipykernel` is in the `dev` group) and choose Restart & Run All. Results are written to
`notebooks/test_output/` (`report.md`, `results.json`, `wise0855_epochs.png`). The recorded run
(2026-11-14) passed 63 of 63.

## Not yet done

- Gaia support (`py/src/planetx/gaia.py` contains only a TODO).
- Proper-motion lookup for custom coordinates (the reticle marks the field centre).
- Progress reporting for live requests (the API returns only when the build is finished).
- Frontend tests.
- Demo and video URLs above are placeholders.

## License

MIT, see `LICENSE`.
