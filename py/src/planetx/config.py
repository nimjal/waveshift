from __future__ import annotations

import os
import tomllib
from functools import lru_cache
from pathlib import Path


@lru_cache
def root() -> Path:
    """Repo root = first parent of this file that contains config/sources.toml.
    If env var PLANETX_ROOT is set, use that instead (needed inside the API container).
    Cache the result (functools.lru_cache). Raise FileNotFoundError if not found."""

    env = os.environ.get("PLANETX_ROOT")
    if env:
        return Path(env).resolve()
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "config" / "sources.toml").exists():
            return parent
    raise FileNotFoundError(f"config/sources.toml not found above {here}")


def load_sources() -> dict:
    """Parse config/sources.toml with tomllib and return the dict."""
    return tomllib.loads((root() / "config" / "sources.toml").read_text())


def load_targets() -> list[dict]:
    """Parse config/targets.toml and return the list under [[target]]."""
    return tomllib.loads((root() / "config" / "targets.toml").read_text())["target"]


def cache_dir() -> Path:
    """Where every cache file lives (live JSON, FITS cutouts). Resolution order:
    1. $PLANETX_CACHE_DIR if set
    2. /tmp/planetx-cache if $VERCEL is set (Vercel's filesystem is read-only except /tmp)
    3. <root>/data/cache
    Does NOT create the directory: writers mkdir right before writing."""

    env = os.environ.get("PLANETX_CACHE_DIR")
    if env:
        return Path(env)
    if os.environ.get("VERCEL"):
        return Path("/tmp/planetx-cache")
    return root() / "data" / "cache"


def web_data_dir() -> Path:
    """<repo>/web/public/data (where the frontend reads JSON from). root() is py/ (it holds
    config/), and web/ is its sibling, so look in root() first, then its parent."""

    r = root()
    for base in (r, r.parent):
        if (base / "web" / "public").is_dir():
            return base / "web" / "public" / "data"
    return r / "web" / "public" / "data"
