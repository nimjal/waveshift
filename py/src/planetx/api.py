from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import config, live

log = logging.getLogger(__name__)

app = FastAPI(title="Planet X API")
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
