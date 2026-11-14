from __future__ import annotations

import json
from pathlib import Path

import numpy as np


def to_jsonable(img: np.ndarray, sig: int = 4) -> list[list[float | None]]:
    """np.flipud (FITS row 0 = bottom -> screen row 0 = top), then a list of lists of
    Python floats rounded to `sig` significant figures; NaN/inf -> None.
    [[1, 2], [3, nan]] -> [[3.0, None], [1.0, 2.0]]"""

    flipped = np.flipud(np.asarray(img, dtype=float))
    return [[float(f"{v:.{sig}g}") if np.isfinite(v) else None for v in row]
            for row in flipped]


SCHEMA_VERSION = 3   # bump when the per-target JSON shape changes (keys the live API cache)


def write_json(path: Path, obj: dict | list) -> None:
    """mkdir parents; json.dumps(obj, allow_nan=False, compact separators);
    write to '<path>.part' then rename (atomic). A NaN must raise ValueError HERE."""
    
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, allow_nan=False, separators=(",", ":"))
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_text(text)
    tmp.replace(path)
