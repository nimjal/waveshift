"""Paths and config loading."""
from __future__ import annotations

from pathlib import Path


def root() -> Path:
    """Repo root = first parent of this file that contains config/sources.toml.
    If env var PLANETX_ROOT is set, use that instead (needed inside the API container).
    Cache the result (functools.lru_cache). Raise FileNotFoundError if not found."""
    raise NotImplementedError


def load_sources() -> dict:
    """Parse config/sources.toml with tomllib and return the dict."""
    raise NotImplementedError


def load_targets() -> list[dict]:
    """Parse config/targets.toml and return the list under [[target]]."""
    raise NotImplementedError


def cache_dir() -> Path:
    """<root>/data/cache — create it if missing, return the Path."""
    raise NotImplementedError


def web_data_dir() -> Path:
    """<root>/web/public/data (where the frontend reads JSON from)."""
    raise NotImplementedError
