# Waveshift codebase map

A reading guide for the repo: what each part does, how data moves through it, and where each
feature lives. Line numbers are as of commit `7943a7f` (14 Nov 2026); every reference also names
the function, so `grep -n` finds it again after edits.

**Data layer.** Files marked **[DATA]** hold the astronomy: reading IRSA files, reprojection,
stacking, blank-pixel reasons, motion, wavelength and photometry. They are written or verified by
Nimit. Change them only with his review, and re-run `notebooks/tests.ipynb` afterwards.

## Purpose

Waveshift is a blink comparator for NASA SPHEREx images (NASA Space Apps 2026, "Planet X"). For a
sky position it shows one small image per observation epoch on a fixed 25 × 25 px grid (6.15″/px,
2.56′ across, north up, east left). Blinking between epochs makes anything that moves or changes
brightness stand out. Five curated targets are prebuilt; any other RA/Dec is fetched live.

## Directory map

```
justfile                 build / api / web / lint
README.md                user-facing description, run instructions, data sources
docs/schema.md           the JSON and API contract (pipeline → web)
notebooks/tests.ipynb    the test suite (96 checks, 17 sections)
data/raw/.gitkeep        leftover from before the cache moved under py/ (see Known gaps)

py/                      Python package `planetx` + the API entry point
  index.py               Vercel entry: puts src/ on sys.path, exports `app`
  pyproject.toml, uv.lock   deps (astropy, astroquery, httpx, numpy, reproject; groups api, dev)
  requirements.txt       `uv export` of the api group, read by Vercel
  config/sources.toml    collections, grid, cutout, flag planes
  config/targets.toml    the five curated targets (SIMBAD position + proper motion)
  data/cache/            FITS cutouts, live plans and frames (git-ignored)
  src/planetx/
    config.py            root(), load_sources(), load_targets(), cache_dir(), web_data_dir()
    targets.py           Target (proper-motion propagation), SIMBAD, Sesame name lookup
    query.py             IRSA SIA query, epoch grouping, detector wavelength ranges
    cutouts.py           IRSA cutout download with retry and disk cache (curated path)
    pipeline.py          build_target: the curated chain end to end
    export.py            numpy → JSON (row flip, NaN → null), atomic writer
    cli.py               `planetx build` and `planetx annotate`
    api.py               FastAPI: /health, /target, /target/refine, /resolve, /photometry
    live.py              live path: plan, cursor, refine loop (uses remote.py + stack.py)
    stack.py      [DATA] grid WCS, FLAGS mask, reprojection, epoch median, blank-pixel reasons
    remote.py     [DATA] HTTP range reads of SPHEREx L2 files (IMAGE rows, RICE FLAGS tiles)
    motion.py     [DATA] measured vs predicted shift (centroid) and the reference-star check
    spectral.py   [DATA] per-pixel wavelength from the WAVE-TAB spectral WCS
    photometry.py [DATA] fixed-aperture light curve, comparison star, outer-glow mode
    reasons.py    [DATA] not in `7943a7f`: being added now as the single home of the
                         blank-pixel reason logic that today sits in stack.py and export.py

web/                     Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui
  index.html, vite.config.ts (base './', alias @ → src), .oxlintrc.json
  public/data/           curated output: targets.json, manifest.json, targets/<id>.json,
                         targets/<id>.spectrum.json (12 MB in total, committed)
  src/
    main.tsx             React root
    App.tsx              page layout, target selection, live refine loop, URL ↔ state
    components/
      BlinkPlayer.tsx    the canvas viewer: epochs, overlays, controls, GIF export
      CuratedList.tsx    list of curated targets
      CustomPanel.tsx    RA/Dec + name search form, API health, live progress, errors
      SpectrumPanel.tsx  spectrum plot for a clicked pixel
      LightCurvePanel.tsx light-curve plot
      SkyContextPanel.tsx Aladin Lite panel
      Guide.tsx          first-visit "how to read a blink" dialog
      ui/                shadcn primitives (button, card, tabs, switch, …)
    lib/
      api.ts             every fetch the app makes (static JSON and the API), error types
      live.ts            LiveStack: running sums of refine deltas → TargetData
      render.ts          stretch, colour maps, blink and difference frames
      spectrum.ts        samples a spectrum from per-exposure frames
      url.ts             URL ↔ view state
      types.ts           TypeScript mirror of docs/schema.md
      coords.ts          RA/Dec parsing (decimal and sexagesimal)
      gif.ts             small GIF encoder
      prefs.ts           localStorage flags
```

## The two data paths

Both paths share the grid, the FLAGS mask and the JSON shape. They differ in how pixels are
fetched and combined.

| | Curated (`just build`) | Live (`just api`) |
| --- | --- | --- |
| Entry | `cli.build` `py/src/planetx/cli.py:18` → `pipeline.build_target` `pipeline.py:23` | `api.target` `api.py:27`, `api.refine` `api.py:69` → `live.py` |
| Images found by | `query.find_images` `query.py:48` (IRSA SIA) | same, inside `live.build_plan` `live.py:71` |
| Pixels from | IRSA cutout service, `cutouts.fetch_many` `cutouts.py:90` | HTTP range reads, `remote.read_window` `remote.py:251` |
| ZODI | subtracted (`stack._load` `stack.py:75`) | skipped (`live._fetch_frame` `live.py:202`) |
| FLAGS mask | `stack.bad_mask` `stack.py:55`, planes from `sources.toml [flags].bad` | same mask |
| On the grid by | `stack.to_grid_reasons` `stack.py:162` (reproject) | `stack.window_to_grid` `stack.py:252` (same reprojection) |
| Combine | **median** per epoch per detector, `stack.stack_epoch` `stack.py:264` | **mean**: server returns sum and count deltas, `web/src/lib/live.ts:94` adds them |
| Blank-pixel reasons | yes (`stack.stack_reasons` `stack.py:212`) | no `reasons` on live frames |
| Output | static JSON in `web/public/data/` | JSON responses; plan and frames cached under `cache_dir()` |

Why they differ: the live server is stateless and refines progressively, and a median cannot be
updated from sums. ZODI is nearly constant over 2.56′ and the per-frame background subtraction
removes it (README "How it works").

## Data flow

```
IRSA SIA (query.py:48) ── which exposures cover the position, grouped into epochs (query.py:84)
   │
   ├─ curated: cutouts.py → stack.py (ZODI, FLAGS, reproject, median) → pipeline.py:23
   │            → motion.py:221, photometry.py:237, spectral.py:184 → export.py:42
   │            → web/public/data/targets/<id>.json (+ .spectrum.json, targets.json, manifest.json)
   │            → lib/api.ts:115 loadCuratedIndex, :128 loadCuratedTarget, :336 loadCuratedSpectrum
   │
   └─ live:    GET /target (api.py:27 → live.py:127 get_plan, :144 plan_response)
                → lib/api.ts:237 fetchLivePlan
               POST /target/refine, repeated (api.py:69 → live.py:278 refine → remote.py:251)
                → lib/api.ts:252 refineLive → lib/live.ts:73 LiveStack (add :94, toTargetData :142)
               POST /photometry (api.py:107 → photometry.py:237) ← lib/api.ts:272 fetchLightcurve
               GET /resolve (api.py:42 → targets.py:179 resolve_name) ← lib/api.ts:318 resolveName
                          │
                          ▼
   App.tsx holds one `Shown` = { data: TargetData, source, spectrum } (App.tsx:40)
     → TargetHeader (App.tsx:192): name, coordinates, motion line, saturation note
     → BlinkPlayer (components/BlinkPlayer.tsx:270): render.ts:162 renderFrames → canvas
         → SpectrumPanel (click a pixel), LightCurvePanel
     → SkyContextPanel (components/SkyContextPanel.tsx:118): grid centre + field size only
```

Curated and live data reach the components in the same `TargetData` shape
(`web/src/lib/types.ts:148`), so the viewer does not know which path produced it.

## JSON and API schema

The contract is [`docs/schema.md`](docs/schema.md). In short:

- `targets.json`: index of curated targets. `manifest.json`: build date, collections, counts.
- `targets/<id>.json`: `target`, `grid`, `detectors`, `epochs[]` (each with `predicted_px` and
  `frames` D1–D6 + ALL), optional `motion` and `lightcurve`.
- `targets/<id>.spectrum.json`: per-exposure frames and a wavelength plane, loaded on first click.
- Live API: `GET /target` (plan), `POST /target/refine` (sum/count deltas + cursor),
  `GET /resolve` (name → position), `POST /photometry` (light curve of the client's stack),
  `GET /health`.
- Rules: row 0 is the top, null means no data, never NaN, east is left.

`web/src/lib/types.ts` mirrors the schema by hand; `lib/api.ts:73` (`looksLikeTargetData`) and
`lib/live.ts:54`/`:60` do light shape checks on what arrives.

## Where each feature lives

| Feature | Backend | Frontend |
| --- | --- | --- |
| Curated target list | `cli.py:18` writes `targets.json` | `components/CuratedList.tsx:15`, `App.tsx:283` selectCurated |
| Custom RA/Dec (live) | `api.py:27`, `api.py:69`, `live.py:71`/`:278` | `components/CustomPanel.tsx:96`, `App.tsx:342` runLive, `lib/live.ts:73` |
| Name search | `api.py:42`, `targets.py:179` (curated aliases `:126`, Sesame `:160`) | `CustomPanel.tsx:140`, `lib/api.ts:318` |
| Blink / difference views, stretch | — | `lib/render.ts:162` renderFrames, `BlinkPlayer.tsx:270` |
| Predicted reticle and track | `pipeline.py:137` (`predicted_px`), `targets.py:22` `Target.at` | `BlinkPlayer.tsx:77` drawOverlay |
| Scale bar, compass | — | `BlinkPlayer.tsx:123`, `:141` |
| Measured vs predicted motion | `motion.py:221` measure_motion, `:201` null_test | `App.tsx:124` MotionLine, `:106` RefStar |
| Blank-pixel reasons, saturation hatch | `stack.py:135` `_classify`, `:176`, `:212`; `export.py:22` | `lib/render.ts:28`/`:46`, `BlinkPlayer.tsx:51` |
| Spectrum on click | `spectral.py:157`/`:184`, `pipeline.py:162` sidecar; live: `live.py:250` | `BlinkPlayer.tsx:403` click, `lib/spectrum.ts:23`, `components/SpectrumPanel.tsx:166` |
| Light curve | `photometry.py:237`, `api.py:107` | `components/LightCurvePanel.tsx:238`, `lib/api.ts:272` |
| Shareable links, Back/Forward | — | `lib/url.ts:49` readUrl, `:94` toSearch; `App.tsx:488` state → URL, `:511` URL → state |
| Embed (`&embed=1`) | — | `App.tsx:566` |
| Copy link | — | `App.tsx:78` |
| GIF export | — | `BlinkPlayer.tsx:189` exportGif, `lib/gif.ts:120` |
| Sky context (Aladin Lite) | — | `components/SkyContextPanel.tsx:118`, mounted at `App.tsx:846` |
| First-visit guide | — | `components/Guide.tsx:57`, `lib/prefs.ts:6` |
| API-down fallback | `api.py:21` /health | `lib/api.ts:167` checkApiHealth, `CustomPanel.tsx:113`, error copy `CustomPanel.tsx:59`; no-API build `lib/api.ts:14` |
| Freshness line | `cli.py:57` manifest | `lib/api.ts:148`, `App.tsx:861` |

## Config files

| File | Holds |
| --- | --- |
| `py/config/sources.toml` | `collections`, `epoch_gap_days` (30), `obs_epoch` (2025.9), `pixel_scale_arcsec` (6.15), `[grid].size_px` (25), `[cutout]` margin and workers, `[flags].bad` and `[flags].saturated` |
| `py/config/targets.toml` | id, name, SIMBAD alias, kind, J2000 position, proper motion (mas/yr, pmra includes cos δ), `ref_epoch` |
| `py/pyproject.toml`, `py/uv.lock`, `py/.python-version` | Python 3.14 and dependencies |
| `py/requirements.txt` | generated: `uv export --frozen --no-default-groups --group api --no-hashes --no-emit-project -o requirements.txt` |
| `web/package.json`, `web/vite.config.ts`, `web/tsconfig*.json`, `web/.oxlintrc.json`, `web/components.json` | frontend build, lint and shadcn config |

Environment variables: `VITE_API_URL` (frontend, baked in at build time; unset in production
disables custom coordinates), `PLANETX_ROOT`, `PLANETX_CACHE_DIR`, `VERCEL` (cache goes to
`/tmp/planetx-cache`), all read in `py/src/planetx/config.py:10`–`47`.

## Commands

```sh
just build                 # curated targets → web/public/data (reuses py/data/cache)
just api                   # FastAPI on :7860, with reload
just web                   # Vite dev server on :5173
just lint                  # oxlint on web/
cd web && npm run build    # tsc -b && vite build → web/dist
cd py && uv run python -m planetx.cli build barnard r-dra   # a subset
cd py && uv run python -m planetx.cli annotate              # recompute motion + lightcurve
                                                            # in the built JSON, no archive access
```

## Tests

`notebooks/tests.ipynb` is the only test suite: 96 checks in 17 sections, one section per module
(the README "Verification" table lists them). Run it with the `py/.venv` kernel, Restart & Run
All; it writes `notebooks/test_output/report.md` and `results.json` (git-ignored). `RUN_LIVE =
False` skips the 6 checks that need the network. The `reasons`, `motion`, `spectral` and
`photometry` sections read cached cutouts in `py/data/cache/` and the built JSON, so they need a
prior `just build` on the machine.

Headless run: `cd py && uv run --with nbconvert jupyter nbconvert --to notebook --execute
../notebooks/tests.ipynb --output-dir /tmp/nb`.

There are no frontend tests and no CI. `npm run build` (type check) and `just lint` are the
frontend gates.

## Deployment

Two Vercel projects build from this repo on every push to `main`. Each posts a commit status on
GitHub (`gh api repos/nimjal/waveshift/commits/<sha>/status`).

| Project | Root | What it serves |
| --- | --- | --- |
| `waveshift-app` | `web/` | the static site, https://waveshift-4billion.vercel.app. Needs `VITE_API_URL` set in the project. |
| `waveshift-api` | `py/` | the FastAPI app through `py/index.py`, dependencies from `py/requirements.txt`. Cache is `/tmp`, so it is lost between cold starts. |

Neither project has a `vercel.json` in the repo; root directory and environment variables are
set in the Vercel dashboard.

## Known gaps and inconsistencies

Data layer:

1. **Saturation is decided in four places.** `stack.py:135`/`:176` turns the FLAGS plane into
   reason code 1 (the source of truth). `motion.py:56`/`:98` and `photometry.py:85`/`:128`/`:193`
   each redefine `SATURATED = "1"` and test the reason strings with their own rule (any null in a
   5 × 5 window; seeds inside the aperture). `web/src/lib/render.ts:63` `coreSaturated` uses a
   fourth rule (5 of 9 pixels in ALL, in most epochs) for the header note at `App.tsx:233`.
   `lib/spectrum.ts:46` also counts code `'1'`. They can disagree on the same target.
2. **`reasons.py` is not in the tree at `7943a7f`.** The reason logic lives in `stack.py:116`–`240`
   and `export.py:22`. A `reasons.py` is being added in parallel; this map should be refreshed
   when it lands.
3. **Live frames carry no blank-pixel reasons**, so a saturated star in a live view shows plain
   "no data" and `/photometry` labels its core "blank, likely saturated".
4. **Median (curated) vs mean (live)** and **ZODI subtracted vs skipped**: deliberate and
   documented, but the same position looks slightly different on the two paths.
5. **Custom positions have zero proper motion** (`targets.py:105` `adhoc`): the reticle marks the
   field centre even when the name search returned a proper motion.
6. **Retry lists differ**: `cutouts.py:16` retries 429 and 503; `remote.py:29` retries 429, 500,
   502, 503, 504.
7. **Detector order is defined three times**: `live.py:37`, `motion.py:48`, `photometry.py:84`.
8. **`obs_epoch` fallback `2025.9` is repeated** as a literal in `pipeline.py:57`/`:73`,
   `live.py:75`/`:162` and `api.py:48`.
9. **`export.SCHEMA_VERSION`** (`export.py:19`) is never read; the live cache is keyed by
   `live.PLAN_VERSION` instead.

Frontend and repo:

10. **`App.tsx` is 880 lines** and mixes layout, the live refine loop and URL sync.
11. **`niceTicks` and `fmt` are duplicated** in `SpectrumPanel.tsx:23`/`:33` and
    `LightCurvePanel.tsx:21`/`:27`.
12. **`lib/api.ts` says every network call lives there**, but `SkyContextPanel.tsx` imports the
    Aladin script from a CDN on its own.
13. **`types.ts` is a hand-written copy of the schema**; nothing checks it against the Python
    output.
14. **Naming**: the product is Waveshift, the package is `planetx`, the API title is "Planet X
    API" (`api.py:13`), `web/README.md` is titled "Planet X · SPHEREx Blink", and
    `pyproject.toml` still has `description = "Add your description here"`.
15. **Repo URLs**: `origin` points at `nimjal/4-billion-2026` (GitHub redirects it to
    `nimjal/waveshift`). The GitHub repo's homepage field is `waveshift-seven.vercel.app`, which
    returns 404; the working site is `waveshift-4billion.vercel.app`.
16. **Root `data/raw/.gitkeep`** and the root `.gitignore` entries for `data/raw/*` and
    `data/cache/*` are leftovers: the cache is `py/data/cache/`.
17. **`py/requirements.txt` is generated by hand**; a dependency change that skips the
    `uv export` breaks only the deployed API.
18. **README**: the demo video URL is a placeholder.
19. **No frontend tests, no CI**; the notebook is run by hand.
20. **CDS is unreachable** (checked 14 Nov 2026: `aladin.cds.unistra.fr`, `alasky.cds.unistra.fr`
    and `vizier.cds.unistra.fr` all return a "Page unavailable" page). The sky panel therefore
    loads Aladin Lite from jsDelivr and imagery from IRSA's HiPS mirror, and `/resolve` relies on
    the Harvard Sesame mirror.
