"""Write the data contract (docs/schema.md). Nothing else touches JSON."""
from __future__ import annotations

from pathlib import Path

import numpy as np


def to_jsonable(img: np.ndarray, sig: int = 4) -> list[list[float | None]]:
    """np.flipud (FITS row 0 = bottom -> screen row 0 = top), then a list of lists of
    Python floats rounded to `sig` significant figures; NaN/inf -> None.
    [[1, 2], [3, nan]] -> [[3.0, None], [1.0, 2.0]]"""
    raise NotImplementedError


def write_json(path: Path, obj: dict | list) -> None:
    """mkdir parents; json.dumps(obj, allow_nan=False, compact separators);
    write to '<path>.part' then rename (atomic). A NaN must raise ValueError HERE."""
    raise NotImplementedError
