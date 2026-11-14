"""Live requests: any RA/Dec -> the SAME JSON shape as the curated files.
CORS open for GET; never add allow_credentials=True with allow_origins=['*']."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query  # noqa: F401

from . import config, targets          # noqa: F401
from .export import write_json         # noqa: F401
from .pipeline import build_target     # noqa: F401  (tests swap api.build_target)

app = FastAPI(title="Planet X API")
# TODO: add CORSMiddleware (allow_origins=["*"], allow_methods=["GET"])


@app.get("/health")
def health() -> dict:
    """{'ok': True}"""
    raise NotImplementedError


@app.get("/target")
def target(ra: float = Query(..., ge=0, lt=360),
           dec: float = Query(..., ge=-90, le=90),
           full: bool = Query(False)) -> dict:
    """Plain `def` (not async): FastAPI runs it in a thread pool, so slow IRSA calls
    don't block other requests.
    - cache file: config.cache_dir()/'live'/f'live_{ra:.4f}_{dec:+.4f}_{"full"|"cap"}.json'
      -> if it exists, return its contents (no rebuild)
    - else build_target(targets.adhoc(ra, dec), sources, config.cache_dir(),
      max_per_group=None if full else sources['live']['max_per_group'])
      (call it as the module-level name `build_target` so tests can swap it)
    - upstream exception -> HTTPException(502); write the cache; return the dict."""
    raise NotImplementedError
