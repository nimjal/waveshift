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
    """<root>/data/cache — create it if missing, return the Path."""

    d = root() / "data" / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def web_data_dir() -> Path:
    """<root>/web/public/data (where the frontend reads JSON from)."""
    
    return root() / "web" / "public" / "data"
