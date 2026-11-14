from __future__ import annotations

import logging
import re
import warnings
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import FITSFixedWarning, WCS

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


# --- why a pixel is blank -----------------------------------------------------------
# Reason codes (docs/schema.md). Only BLANK (NaN) pixels get a reason; finite pixels are
# VALID even if a flag bit is set on them.
VALID, SATURATED, FLAGGED, NO_DATA = 0, 1, 2, 3

# Which mask planes mean what is NOT hardcoded: names and bits are read from each cutout's
# FLAGS header (MSKNnnnn = plane name, MSKMnnnn = 1<<n, MSKDnnnn = description; see
# flag_bits) and the planes that count as saturation come from sources.toml
# [flags].saturated. SPHEREx has no plane literally called SATURATED; the one that marks
# it is MSKN0001 = 'OVERFLOW', MSKD0001 = 'Overflow detected during SUR' (checked on R Dra
# cutouts, Nov 2026: every NaN pixel in them carries OVERFLOW). Plane sets differ between
# files (some add SATELLITE_HALO), so every file is decoded with its own header.


@dataclass
class Blank:
    """Per-pixel reason a frame is blank. codes: uint8 (VALID..NO_DATA), same shape as the
    image. names: the flag that explains each FLAGGED pixel ('' elsewhere)."""
    codes: np.ndarray
    names: np.ndarray


def _classify(data: np.ndarray, flags: np.ndarray | None, bits: dict[str, int],
              bad_flags: list[str], sat_flags: list[str]) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Native-pixel indicator masks for blank pixels: {'SAT': ..., '<FLAG>': ..., 'NODATA': ...}.
    Precedence: saturation first (raw NaNs carry OVERFLOW *and* SUR_ERROR), then the first
    `bad_flags` plane set (in config order), else no-data."""

    blank = ~np.isfinite(data)
    left = blank.copy()
    masks: dict[str, np.ndarray] = {}
    if flags is not None and bits:
        sat_val = 0
        for name in sat_flags:
            if name in bits:
                sat_val |= 1 << bits[name]
        if sat_val:
            masks["SAT"] = left & ((flags & sat_val) != 0)
            left &= ~masks["SAT"]
        for name in bad_flags:
            if name in bits and left.any():
                m = left & (((flags >> bits[name]) & 1) != 0)
                if m.any():
                    masks[name] = m
                    left &= ~m
    masks["NODATA"] = left
    return blank, masks


def to_grid_reasons(path: Path, grid: WCS, size_px: int, bad_flags: list[str] | None = None,
                    sat_flags: list[str] | None = None,
                    subtract_background: bool = True) -> tuple[np.ndarray, Blank]:
    """to_grid plus a Blank for the output grid.
    Each native indicator mask goes through the SAME bilinear reproject_interp as the data
    and counts where > 0, so a blank output pixel gets the reason of whatever blank native
    pixel(s) its interpolation stencil touched. (Nearest-neighbour would miss the pixels
    that bilinear interpolation blanks next to a NaN.) Output outside the footprint = NO_DATA."""

    data, wcs, _, flags, bits = _load(path, list(bad_flags or []), True)
    out = window_to_grid(data, wcs, grid, size_px, subtract_background)
    return out, window_reasons(data, wcs, flags, bits, out, grid, size_px, bad_flags, sat_flags)


def window_reasons(data: np.ndarray, wcs: WCS, flags: np.ndarray | None, bits: dict[str, int],
                   out: np.ndarray, grid: WCS, size_px: int, bad_flags: list[str] | None = None,
                   sat_flags: list[str] | None = None) -> Blank:
    """The reason half of to_grid_reasons for an already-loaded window: `data` = native
    pixels AFTER bad-flag masking, `flags`/`bits` = its raw FLAGS array and flag_bits(header)
    (None/{} if unavailable -> every blank is NO_DATA), `out` = window_to_grid(data, ...).
    Shared by the build pipeline and the live path so both explain blanks the same way."""

    from reproject import reproject_interp

    bad_flags, sat_flags = list(bad_flags or []), list(sat_flags or [])
    _, masks = _classify(data, flags, bits, bad_flags, sat_flags)
    blank_out = ~np.isfinite(out)
    codes = np.zeros(out.shape, np.uint8)
    names = np.full(out.shape, "", dtype=object)
    codes[blank_out] = NO_DATA
    best = np.zeros(out.shape)                       # strongest FLAGGED weight so far
    sat = np.zeros(out.shape, bool)
    for key, m in masks.items():
        if key == "NODATA" or not m.any():
            continue
        w, _ = reproject_interp((m.astype(float), wcs), grid, shape_out=(size_px, size_px))
        w = np.nan_to_num(w)
        if key == "SAT":
            sat = blank_out & (w > 0)
        else:
            take = blank_out & (w > best)
            names[take] = key
            best = np.where(take, w, best)
    flagged = blank_out & ~sat & (best > 0)
    codes[flagged] = FLAGGED
    codes[sat] = SATURATED
    names[codes != FLAGGED] = ""
    return Blank(codes, names)


def stack_reasons(img: np.ndarray | None, arrays: list[np.ndarray | None],
                  blanks: list[Blank | None]) -> Blank | None:
    """Reasons for a stacked image (from stack_epoch over `arrays`). A stacked pixel is blank
    only when every frame that went into the stack is blank there. Rule: if ANY of those
    frames says SATURATED -> SATURATED; else if any says FLAGGED -> FLAGGED (the flag name
    that occurs most often); else NO_DATA. Frames stack_epoch dropped are ignored."""

    if img is None:
        return None
    used = [b for a, b in zip(arrays, blanks)
            if a is not None and b is not None and np.isfinite(a).any()]
    codes = np.zeros(img.shape, np.uint8)
    names = np.full(img.shape, "", dtype=object)
    blank = ~np.isfinite(img)
    if not blank.any():
        return Blank(codes, names)
    if not used:
        codes[blank] = NO_DATA
        return Blank(codes, names)
    C = np.stack([b.codes for b in used])
    codes[blank] = NO_DATA
    any_flag = blank & (C == FLAGGED).any(axis=0)
    codes[any_flag] = FLAGGED
    codes[blank & (C == SATURATED).any(axis=0)] = SATURATED
    for r, c in zip(*np.nonzero(codes == FLAGGED)):
        votes = Counter(b.names[r, c] for b in used if b.codes[r, c] == FLAGGED)
        names[r, c] = votes.most_common(1)[0][0]
    return Blank(codes, names)


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
