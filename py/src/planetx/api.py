from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import config, live, photometry, targets

log = logging.getLogger(__name__)

app = FastAPI(title="Waveshift API")
# POST /target/refine sends JSON, so browsers preflight it: allow POST + Content-Type.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])

REFINE_BUDGET_S = 15.0
REFINE_WORKERS = 6


@app.get("/health")
def health() -> dict:
    """Liveness only: no filesystem or config access."""
    return {"status": "ok"}


@app.get("/target")
def target(ra: float = Query(..., ge=0, lt=360),
           dec: float = Query(..., ge=-90, le=90)) -> dict:
    """The refinement plan for a position: grid, epochs, the ordered exposure list per
    epoch and the starting cursor. One SIA query, no pixels (a few seconds).
    Pixels come from POST /target/refine. See docs/schema.md."""

    sources = config.load_sources()
    try:
        plan = live.get_plan(ra, dec, sources)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"upstream failure: {type(e).__name__}: {e}") from e
    return live.plan_response(plan, sources)


@app.get("/resolve")
def resolve(name: str = Query(..., min_length=1, max_length=100)) -> dict:
    """Object name -> position (curated aliases first, then CDS Sesame), with the position
    propagated by proper motion to the grid epoch. 404 = not found; 502 = Sesame down."""

    sources = config.load_sources()
    epoch = float(sources["spherex"].get("obs_epoch", 2025.9))
    try:
        cfgs = config.load_targets()
    except (OSError, KeyError, ValueError):
        cfgs = []
    try:
        hit = targets.resolve_name(name.strip(), epoch, cfgs)
    except ConnectionError as e:
        raise HTTPException(502, f"name resolver unavailable: {e}") from e
    if hit is None:
        raise HTTPException(404, f"no object called {name.strip()!r} was found")
    return hit


class RefineRequest(BaseModel):
    ra: float = Field(..., ge=0, lt=360)
    dec: float = Field(..., ge=-90, le=90)
    cursor: str = Field(..., max_length=64)
    batch_per_epoch: int = Field(2, ge=1, le=12)


@app.post("/target/refine")
def refine(req: RefineRequest) -> dict:
    """Fetch the next `batch_per_epoch` exposures of EVERY epoch (round-robin, whole
    rounds only, so epochs stay equally deep) for at most ~15 s. Stateless: returns
    per-call sum / valid-count deltas and the next cursor. Plain `def`: runs in the
    thread pool, so slow archive calls don't block other requests."""

    sources = config.load_sources()
    try:
        return live.refine(req.ra, req.dec, req.cursor, req.batch_per_epoch, sources,
                           budget_s=REFINE_BUDGET_S, workers=REFINE_WORKERS)
    except live.BadCursor as e:
        raise HTTPException(422, str(e)) from e
    except live.PlanMismatch as e:
        raise HTTPException(409, f"plan changed, restart from GET /target: {e}") from e
    except Exception as e:  # noqa: BLE001
        log.exception("refine failed")
        raise HTTPException(502, f"upstream failure: {type(e).__name__}: {e}") from e


class PhotFrame(BaseModel):
    pixels: list[list[float | None]] = Field(..., max_length=64)
    reasons: list[str] | None = Field(None, max_length=64)


class PhotEpoch(BaseModel):
    id: str = Field(..., max_length=8)
    mjd_start: float
    mjd_end: float
    predicted_px: dict[str, float]
    frames: dict[str, PhotFrame] = Field(..., max_length=8)


class PhotometryRequest(BaseModel):
    pixel_scale_arcsec: float = Field(..., gt=0, lt=100)
    epochs: list[PhotEpoch] = Field(..., min_length=1, max_length=16)


@app.post("/photometry")
def photometry_endpoint(req: PhotometryRequest) -> dict:
    """Light curve (photometry.measure_lightcurve) of frames the client already has: the live
    view's mean-stacked frames. /target/refine only returns per-call deltas, and the server keeps
    no state, so the client sends the stack it holds. Pure computation, no archive access."""

    epochs = []
    for e in req.epochs:
        if "x" not in e.predicted_px or "y" not in e.predicted_px:
            raise HTTPException(422, f"epoch {e.id}: predicted_px needs x and y")
        frames = {}
        for k, f in e.frames.items():
            if k not in photometry.FRAME_KEYS and k != "ALL":
                raise HTTPException(422, f"unknown frame key {k!r}")
            n = len(f.pixels)
            if any(len(r) != n for r in f.pixels) or (f.reasons and (len(f.reasons) != n or any(len(r) != n for r in f.reasons))):
                raise HTTPException(422, f"epoch {e.id} {k}: frames must be square")
            frames[k] = f.model_dump(exclude_none=True)
        epochs.append({"id": e.id, "mjd_start": e.mjd_start, "mjd_end": e.mjd_end,
                       "predicted_px": e.predicted_px, "frames": frames})
    sizes = {len(f["pixels"]) for e in epochs for f in e["frames"].values()}
    if len(sizes) > 1:
        raise HTTPException(422, "all frames must have the same size")
    return photometry.measure_lightcurve({"grid": {"pixel_scale_arcsec": req.pixel_scale_arcsec}, "epochs": epochs}) or {}
