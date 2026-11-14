"""Fetch small cutouts of spectral images, cached on disk."""
from __future__ import annotations

from pathlib import Path
from typing import Callable

import httpx
from astropy.coordinates import SkyCoord


def cutout_url(access_url: str, coord: SkyCoord, size_deg: float) -> str:
    """access_url + '?center=<ra>,<dec>&size=<size>'
    ra/dec in decimal degrees, 6 dp; size 5 dp.
    e.g. '...fits?center=133.795100,-7.245100&size=0.05000'"""
    raise NotImplementedError


def cache_path(url: str, cache_dir: Path) -> Path:
    """cache_dir / '<hash of the FULL url>.fits'.
    The key must include position + size, not just obs_id — the same exposure
    cut around two targets must NOT collide."""
    raise NotImplementedError


def fetch_cutout(url: str, cache_dir: Path, client: httpx.Client | None = None,
                 timeout: float = 120.0, retries: int = 4) -> Path:
    """Return cache_path(url). If missing: GET (follow redirects).
    IRSA rate-limits: on 503 / 429 / timeout, retry up to `retries` times with
    backoff (e.g. 1, 2, 4, 8 s). Other HTTP errors -> raise.
    Raise ValueError if the body doesn't start with b'SIMPLE' (not FITS).
    Write atomically (.part then rename). Close the client only if you created it."""
    raise NotImplementedError


def fetch_many(urls: list[str], cache_dir: Path, workers: int = 4,
               progress: Callable[[int, int], None] | None = None) -> list[Path | None]:
    """Parallel fetch_cutout (ThreadPoolExecutor + one shared httpx.Client).
    Keep workers low (4): 8 parallel requests got ~30% 503s from IRSA on 14 Nov.
    Same order as urls. A failure becomes None (logged), never kills the batch.
    Call progress(done, total) after each URL if given."""
    raise NotImplementedError
