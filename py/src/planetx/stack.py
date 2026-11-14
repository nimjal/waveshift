"""Put every cutout on one shared grid and median-combine per epoch.
Units are MJy/sr (surface brightness) -> plain interpolation, no flux rescaling."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS


def make_grid(coord: SkyCoord, size_px: int, scale_arcsec: float) -> WCS:
    """2-D TAN WCS centred on coord: north up, east left (CDELT1 < 0 < CDELT2),
    CRPIX = (size_px+1)/2 (FITS is 1-based) so the target is pixel ((n-1)/2, (n-1)/2)
    for odd n. Set pixel_shape = (size_px, size_px)."""
    raise NotImplementedError


def flag_bits(header: fits.Header) -> dict[str, int]:
    """Mask-plane definitions from the FLAGS header. SPHEREx writes, per plane n:
      MSKN0010 = 'HOT'   (name)   MSKM0010 = 1024 (= 1<<10)   MSKD0010 = description
    -> return {'HOT': 10, ...}  (name stripped, bit number from the key digits)."""
    raise NotImplementedError


def bad_mask(flags: np.ndarray, header: fits.Header, bad: list[str]) -> np.ndarray:
    """Boolean array: True where any bit named in `bad` is set.
    If the header has no MSKN* keys: all False (and log a warning once).
    NEVER include 'SOURCE' in bad — it marks real stars."""
    raise NotImplementedError


def load_cutout(path: Path, bad_flags: list[str] | None = None,
                subtract_zodi: bool = True) -> tuple[np.ndarray, WCS, dict]:
    """Open the MEF. data = IMAGE as float (fall back to HDU 1 if no 'IMAGE').
    If ZODI exists (same shape): data -= ZODI. If bad_flags and FLAGS exist: bad -> NaN.
    WCS = WCS(IMAGE header).celestial (silence FITSFixedWarning).
    meta = {'bunit': BUNIT or None, 'masked': number of pixels set to NaN}."""
    raise NotImplementedError


def to_grid(path: Path, grid: WCS, size_px: int, bad_flags: list[str] | None = None,
            subtract_background: bool = True) -> np.ndarray:
    """load_cutout -> reproject_interp onto grid, shape (size_px, size_px).
    footprint == 0 -> NaN. If subtract_background: subtract nanmedian of the result
    (so epochs blink at the same level)."""
    raise NotImplementedError


def stack_epoch(arrays: list[np.ndarray | None]) -> tuple[np.ndarray | None, int]:
    """Drop None and all-NaN frames; nanmedian over the rest -> (image, n_used).
    Nothing usable -> (None, 0). Silence the all-NaN-slice RuntimeWarning."""
    raise NotImplementedError
