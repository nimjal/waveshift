from __future__ import annotations

import json
import logging

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import config, targets
from .export import write_json
from .pipeline import build_target     # tests swap api.build_target

log = logging.getLogger(__name__)

app = FastAPI(title="Planet X API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])


@app.get("/health")
def health() -> dict:
    """Liveness only: no filesystem or config access."""
    return {"status": "ok"}


@app.get("/target")
def target(ra: float = Query(..., ge=0, lt=360),
           dec: float = Query(..., ge=-90, le=90),
           full: bool = Query(False, description="all images instead of a capped sample")) -> dict:
    """Plain `def` (not async): FastAPI runs it in a thread pool, so slow IRSA calls
    don't block other requests.
    - cache file: config.cache_dir()/'live'/f'live_{ra:.4f}_{dec:+.4f}_{"full"|"cap"}.json'
      -> if it exists, return its contents (no rebuild)
    - else build_target(targets.adhoc(ra, dec), sources, config.cache_dir(),
      max_per_group=None if full else sources['live']['max_per_group'])
      (call it as the module-level name `build_target` so tests can swap it)
    - upstream exception -> HTTPException(502); write the cache; return the dict."""

    sources = config.load_sources()
    key = f"live_{ra:.4f}_{dec:+.4f}_{'full' if full else 'cap'}.json"
    cache = config.cache_dir()
    cached = cache / "live" / key

    if cached.exists():
        return json.loads(cached.read_text())
    cap = None if full else int(sources.get("live", {}).get("max_per_group", 4))

    try:
        data = build_target(targets.adhoc(ra, dec), sources, cache, max_per_group=cap)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"upstream failure: {type(e).__name__}: {e}") from e

    try:
        write_json(cached, data)
    except OSError as e:
        log.warning("could not write live cache %s: %s", cached, e)
    return data
