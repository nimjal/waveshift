from __future__ import annotations

import logging
import re
import warnings
from pathlib import Path

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import FITSFixedWarning, WCS

from . import reasons

log = logging.getLogger(__name__)
_warned_no_flags = False
_MSKN = re.compile(r"^MSKN(\d+)$")


def make_grid(coord: SkyCoord, size_px: int, scale_arcsec: float) -> WCS:
    """2-D TAN WCS centred on coord: north up, east left (CDELT1 < 0 < CDELT2),
    CRPIX = (size_px+1)/2 (FITS is 1-based) so the target is pixel ((n-1)/2, (n-1)/2)
    for odd n. Set pixel_shape = (size_px, size_px)."""

    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.cunit = ["deg", "deg"]
    w.wcs.crval = [coord.ra.deg, coord.dec.deg]
    w.wcs.crpix = [(size_px + 1) / 2, (size_px + 1) / 2]  # FITS is 1-based
    w.wcs.cdelt = [-scale_arcsec / 3600.0, scale_arcsec / 3600.0]
    w.pixel_shape = (size_px, size_px)
    return w


def _ext(hdul: fits.HDUList, name: str):
    try:
        return hdul[name]
    except KeyError:
        return None


def flag_bits(header: fits.Header) -> dict[str, int]:
    """Mask-plane definitions from the FLAGS header. SPHEREx writes, per plane n:
      MSKN0010 = 'HOT'   (name)   MSKM0010 = 1024 (= 1<<10)   MSKD0010 = description
    -> return {'HOT': 10, ...}  (name stripped, bit number from the key digits)."""

    out = {}
    for k, v in header.items():
        m = _MSKN.match(k)
        if m:
            out[str(v).strip()] = int(m.group(1))
    return out


def bad_mask(flags: np.ndarray, header: fits.Header, bad: list[str]) -> np.ndarray:
    """Boolean array: True where any bit named in `bad` is set.
    If the header has no MSKN* keys: all False (and log a warning once).
    NEVER include 'SOURCE' in bad — it marks real stars."""

    global _warned_no_flags
    bits = flag_bits(header)
    if not bits:
        if not _warned_no_flags:
            log.warning("FLAGS header has no MSKN* keys — no pixels masked")
            _warned_no_flags = True
        return np.zeros(flags.shape, dtype=bool)
    
    mask_val = 0
    for name in bad:
        if name in bits:
            mask_val |= 1 << bits[name]
    return (flags.astype(np.int64) & mask_val) != 0


def _load(path, bad_flags, subtract_zodi):
    """load_cutout + the raw FLAGS array and its {name: bit} map (None/{} if absent)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)

        with fits.open(path) as h:
            img = _ext(h, "IMAGE") or h[1]
            data = np.array(img.data, dtype=float)
            wcs = WCS(img.header).celestial
            meta = {"bunit": img.header.get("BUNIT"), "masked": 0}
            zodi = _ext(h, "ZODI")

            if subtract_zodi and zodi is not None and zodi.data is not None \
                    and zodi.data.shape == data.shape:
                data -= zodi.data
            fl = _ext(h, "FLAGS")
            flags, bits = None, {}
            if fl is not None and fl.data is not None and fl.data.shape == data.shape:
                flags, bits = np.array(fl.data, dtype=np.int64), flag_bits(fl.header)
                if bad_flags:
                    m = bad_mask(fl.data, fl.header, bad_flags)
                    data[m] = np.nan
                    meta["masked"] = int(m.sum())

    return data, wcs, meta, flags, bits


def load_cutout(path: Path, bad_flags: list[str] | None = None,
                subtract_zodi: bool = True) -> tuple[np.ndarray, WCS, dict]:
    """Open the MEF. data = IMAGE as float (fall back to HDU 1 if no 'IMAGE').
    If ZODI exists (same shape): data -= ZODI. If bad_flags and FLAGS exist: bad -> NaN.
    WCS = WCS(IMAGE header).celestial (silence FITSFixedWarning).
    meta = {'bunit': BUNIT or None, 'masked': number of pixels set to NaN}."""

    data, wcs, meta, _, _ = _load(path, bad_flags, subtract_zodi)
    return data, wcs, meta


# --- why a pixel is blank: planetx/reasons.py (shared with the live path) -------------

def to_grid_reasons(path: Path, grid: WCS, size_px: int, table: reasons.Table,
                    subtract_background: bool = True) -> tuple[np.ndarray, reasons.Reasons]:
    """to_grid (masking with table.bad) plus the per-pixel reasons on the output grid
    (reasons.native -> reasons.frame: same bilinear stencil as the data)."""
    data, wcs, _, flags, bits = _load(path, list(table.bad), True)
    out = window_to_grid(data, wcs, grid, size_px, subtract_background)
    return out, window_reasons(data, wcs, flags, bits, out, grid, size_px, table)


def window_reasons(data: np.ndarray, wcs: WCS, flags: np.ndarray | None, bits: dict[str, int],
                   out: np.ndarray, grid: WCS, size_px: int, table: reasons.Table) -> reasons.Reasons:
    """Reasons for an already-loaded window: `data` = native pixels AFTER bad-flag masking,
    `flags`/`bits` = its raw FLAGS array and flag_bits(header) (None/{} if unavailable),
    `out` = window_to_grid(data, ...). Used by the build pipeline and the live path alike."""
    return reasons.frame(reasons.native(data, flags, bits, table), wcs, out, grid, size_px, table)


def to_grid(path: Path, grid: WCS, size_px: int, bad_flags: list[str] | None = None,
            subtract_background: bool = True) -> np.ndarray:
    """load_cutout -> reproject_interp onto grid, shape (size_px, size_px).
    footprint == 0 -> NaN. If subtract_background: subtract nanmedian of the result
    (so epochs blink at the same level)."""

    data, wcs, _ = load_cutout(path, bad_flags)
    return window_to_grid(data, wcs, grid, size_px, subtract_background)


def window_to_grid(data: np.ndarray, wcs: WCS, grid: WCS, size_px: int,
                   subtract_background: bool = True) -> np.ndarray:
    """reproject an already-loaded (data, wcs) window onto grid; same rules as to_grid."""
    from reproject import reproject_interp

    out, footprint = reproject_interp((data, wcs), grid, shape_out=(size_px, size_px))
    out[footprint == 0] = np.nan
    if subtract_background and np.isfinite(out).any():
        out -= np.nanmedian(out)
    return out


def stack_epoch(arrays: list[np.ndarray | None]) -> tuple[np.ndarray | None, int]:
    """Drop None and all-NaN frames; nanmedian over the rest -> (image, n_used).
    Nothing usable -> (None, 0). Silence the all-NaN-slice RuntimeWarning."""
    
    arrs = [a for a in arrays if a is not None and np.isfinite(a).any()]
    if not arrs:
        return None, 0
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN pixels stay NaN
        return np.nanmedian(np.stack(arrs), axis=0), len(arrs)
