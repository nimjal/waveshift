from __future__ import annotations

import hashlib
import io
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

import httpx
from astropy.coordinates import SkyCoord

log = logging.getLogger(__name__)

RETRY_STATUS = {429, 503}


def cutout_url(access_url: str, coord: SkyCoord, size_deg: float) -> str:
    """access_url + '?center=<ra>,<dec>&size=<size>'
    ra/dec in decimal degrees, 6 dp; size 5 dp.
    e.g. '...fits?center=133.795100,-7.245100&size=0.05000'"""

    return f"{access_url}?center={coord.ra.deg:.6f},{coord.dec.deg:.6f}&size={size_deg:.5f}"


def cache_path(url: str, cache_dir: Path) -> Path:
    """cache_dir / '<hash of the FULL url>.fits'.
    The key must include position + size, not just obs_id — the same exposure
    cut around two targets must NOT collide."""

    return Path(cache_dir) / f"{hashlib.sha1(url.encode()).hexdigest()[:24]}.fits"


def _get(client: httpx.Client, url: str, retries: int) -> httpx.Response:
    """GET with exponential backoff (1, 2, 4, 8 s ...) on 503 / 429 / timeout."""

    for attempt in range(retries + 1):
        last = attempt == retries
        try:
            r = client.get(url)
        except httpx.TimeoutException:
            if last:
                raise
            log.info("timeout, retry %d/%d: %s", attempt + 1, retries, url)
        else:
            if r.status_code not in RETRY_STATUS or last:
                r.raise_for_status()
                return r
            log.info("HTTP %d, retry %d/%d: %s", r.status_code, attempt + 1, retries, url)
        time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def fetch_cutout(url: str, cache_dir: Path, client: httpx.Client | None = None,
                 timeout: float = 120.0, retries: int = 4) -> Path | io.BytesIO:
    """Return cache_path(url). If missing: GET (follow redirects).
    IRSA rate-limits: on 503 / 429 / timeout, retry up to `retries` times with
    backoff (e.g. 1, 2, 4, 8 s). Other HTTP errors -> raise.
    Raise ValueError if the body doesn't start with b'SIMPLE' (not FITS).
    Write atomically (.part then rename). If the cache can't be written (read-only
    filesystem etc.), log a warning and return the bytes as a BytesIO instead
    (fits.open accepts either). Close the client only if you created it."""

    path = cache_path(url, cache_dir)
    if path.exists() and path.stat().st_size > 0:
        return path
    own = client is None
    client = client or httpx.Client(follow_redirects=True, timeout=timeout)

    try:
        r = _get(client, url, retries)
        if not r.content.startswith(b"SIMPLE"):
            raise ValueError(f"not a FITS file: {r.text[:200]!r}")
    finally:
        if own:
            client.close()

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        tmp.write_bytes(r.content)
        tmp.replace(path)
    except OSError as e:
        log.warning("could not cache cutout %s: %s (serving from memory)", path, e)
        return io.BytesIO(r.content)
    return path


def fetch_many(urls: list[str], cache_dir: Path, workers: int = 4,
               progress: Callable[[int, int], None] | None = None) -> list[Path | io.BytesIO | None]:
    """Parallel fetch_cutout (ThreadPoolExecutor + one shared httpx.Client).
    Keep workers low (4): 8 parallel requests got ~30% 503s from IRSA on 14 Nov.
    Same order as urls. A failure becomes None (logged), never kills the batch.
    Call progress(done, total) after each URL if given."""
    
    done = 0

    def one(u: str) -> Path | io.BytesIO | None:
        nonlocal done
        try:
            return fetch_cutout(u, cache_dir, client)
        except Exception as e:  # noqa: BLE001 — log and carry on
            log.warning("cutout failed: %s (%s)", u, e)
            return None
        finally:
            done += 1
            if progress:
                progress(done, len(urls))

    with httpx.Client(follow_redirects=True, timeout=120.0) as client, \
            ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(one, urls))
