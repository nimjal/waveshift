"""Wavelength of each SPHEREx pixel, from the spectral WCS stored in every L2 exposure.

SPHEREx has no grating: each detector sits behind a linear variable filter, so the central
wavelength changes smoothly across the detector. A star observed in many exposures lands on
different detector pixels each time and so is sampled at a different wavelength each time.
That is why a spectrum can be built from the exposures of one sky position.

The L2 files describe this with an alternate WCS (key 'W') on the IMAGE header, a FITS
"-TAB" lookup table (Greisen et al. 2006, A&A 446, 747 = FITS WCS Paper III, Sect. 6.1).
Keywords this module relies on (values as found in dr1 / qr3 files, Nov 2026):

  IMAGE header
    CTYPE1W = CTYPE2W = 'WAVE-TAB'   bilinear lookup table
    CUNIT1W = CUNIT2W = 'um'         wavelength (axis 1) and bandwidth (axis 2) in microns
    CRPIX1W, CRPIX2W                 reference pixel. 1 in full files; the IRSA cutout
                                     service shifts it (e.g. -1227) so the table stays in
                                     raw detector coordinates ("Lookup table is in raw FITS
                                     coordinates")
    CRVAL1W = CRVAL2W = 1            index-vector value at the reference pixel
    CDELT1W = CDELT2W = 1            index-vector step per pixel
    PS1_0W = PS2_0W = 'WCS-WAVE'     extension holding the table
    PS1_1W = PS2_1W = 'VALUES'       column with the coordinate array
    PS1_2W = 'X', PS2_2W = 'Y'       columns with the index vectors (detector control points)
    PV1_3W = 1, PV2_3W = 2           which component of VALUES is axis 1 / axis 2
                                     (1 = wavelength, 2 = bandwidth)
  WCS-WAVE extension (BINTABLE, 1 row)
    X  (11J)        control-point detector columns, 1-based: 1, 205, ... (NOT evenly spaced)
    Y  (11J)        control-point detector rows, 1-based
    VALUES (242E), TDIM3 = '(2,11,11)'  Fortran order (component, X index, Y index), which is
                    numpy shape (11 [Y], 11 [X], 2 [component]) after astropy applies TDIM.

No PCi_jW / CDi_jW keys are written, so the linear transformation matrix is the identity:
wavelength and bandwidth both depend on (pixel x, pixel y) through the same 2-D table.
Cross-check: astropy's WCS(header, fobj=hdul, key='W') runs the same lookup through wcslib,
but it also applies the celestial SIP distortion keys (A_p_q / B_p_q, which have no 'W'
variant) to the pixel coordinates first, and that shifts the wavelength by up to ~0.005 um.
The table is indexed by raw detector pixels, so SIP doesn't belong in this lookup. With the
SIP keys removed, wcslib and wavelength_at() agree to ~1e-15 um (notebook check).

The table is a property of the detector and calibration, not of the exposure: every file
with the same DETECTOR and the same 'HISTORY [CALIB] spectral_wcs <id>' line carries an
identical table (checked on 600 cached cutouts, Nov 2026). calib_id() returns that id so
the live path can fetch each table once.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

_CALIB = re.compile(r"\[CALIB\]\s+spectral_wcs\s+(\S+)")


@dataclass
class WaveTable:
    """Contents of the WCS-WAVE extension.
    x: (K1,) index vector for pixel axis 1, 1-based detector columns, increasing
    y: (K2,) index vector for pixel axis 2, 1-based detector rows, increasing
    values: (K2, K1, M) coordinate array; values[iy, ix, m] (m = 0 wavelength, 1 bandwidth)"""
    x: np.ndarray
    y: np.ndarray
    values: np.ndarray


def read_wave_table(hdu: fits.BinTableHDU, header: fits.Header) -> WaveTable:
    """WaveTable from the WCS-WAVE extension, using the column names the IMAGE `header`
    points to (PS1_1W / PS1_2W / PS2_2W). Raises ValueError if the extension name doesn't
    match PS1_0W or the array shapes disagree."""

    if hdu.name != str(header.get("PS1_0W", "WCS-WAVE")).strip():
        raise ValueError(f"spectral table is in {header.get('PS1_0W')!r}, got extension {hdu.name!r}")
    col_v = str(header.get("PS1_1W", "VALUES")).strip()
    col_x = str(header.get("PS1_2W", "X")).strip()
    col_y = str(header.get("PS2_2W", "Y")).strip()
    row = hdu.data[0]                            # the whole table is a single row
    x = np.asarray(row[col_x], dtype=float).ravel()
    y = np.asarray(row[col_y], dtype=float).ravel()
    values = np.asarray(row[col_v], dtype=float)  # astropy applies TDIM: (K2, K1, M)
    if values.shape[:2] != (y.size, x.size) or values.ndim != 3:
        raise ValueError(f"VALUES shape {values.shape} does not match X ({x.size}) / Y ({y.size})")
    if np.any(np.diff(x) <= 0) or np.any(np.diff(y) <= 0):
        raise ValueError("index vectors must increase monotonically")
    return WaveTable(x, y, values)


def calib_id(header: fits.Header) -> str | None:
    """The spectral-WCS calibration id from 'HISTORY [CALIB] spectral_wcs <id>', or None."""
    for line in header.get("HISTORY", []):
        m = _CALIB.search(str(line))
        if m:
            return m.group(1)
    return None


def _check_header(header: fits.Header) -> None:
    """The keywords above, as this implementation assumes them. Anything else -> ValueError,
    rather than a silently wrong wavelength."""
    for i in (1, 2):
        if str(header.get(f"CTYPE{i}W", "")).strip() != "WAVE-TAB":
            raise ValueError(f"CTYPE{i}W is {header.get(f'CTYPE{i}W')!r}, expected 'WAVE-TAB'")
        if str(header.get(f"CUNIT{i}W", "um")).strip() not in ("um", "micron"):
            raise ValueError(f"CUNIT{i}W is {header.get(f'CUNIT{i}W')!r}, expected 'um'")
    if any(re.fullmatch(r"(PC|CD)\d_\dW", k) for k in header):
        raise ValueError("PCi_jW / CDi_jW present: a non-identity matrix is not supported")
    if (int(header.get("PV1_3W", 1)), int(header.get("PV2_3W", 2))) != (1, 2):
        raise ValueError("expected PV1_3W = 1 (wavelength) and PV2_3W = 2 (bandwidth)")


def _fractional_index(psi: np.ndarray, index_vector: np.ndarray) -> np.ndarray:
    """Paper III eq. 87: where psi falls in the index vector, as a fractional 0-based index
    (k + (psi - Psi_k) / (Psi_k+1 - Psi_k)). Outside [Psi_0, Psi_last] -> NaN (no extrapolation)."""
    k = np.arange(index_vector.size, dtype=float)
    out = np.interp(psi, index_vector, k)
    return np.where((psi >= index_vector[0]) & (psi <= index_vector[-1]), out, np.nan)


def wavelength_at(header: fits.Header, table: WaveTable, x, y) -> tuple[np.ndarray, np.ndarray]:
    """Central wavelength and bandwidth (microns) at 0-based pixel coordinates (x, y) of the
    image whose header is `header` (an IMAGE header, a cutout of one, or a window of one with
    CRPIXjW shifted like CRPIXj).

    Steps (FITS WCS Paper III, Sect. 6.1, '-TAB'):
      1. FITS pixel coordinate p_j = x + 1 (axis 1), y + 1 (axis 2): FITS counts from 1.
      2. Index-vector coordinate psi_j = CRVALjW + CDELTjW * (p_j - CRPIXjW)
         (the PC matrix is the identity, see _check_header). With the IRSA values this is the
         raw 1-based detector pixel, even in a cutout.
      3. Fractional table index: locate psi_1 in X and psi_2 in Y (linear between the
         control points, which are unevenly spaced).
      4. Bilinear interpolation of VALUES at those fractional indices; component PV1_3W
         (wavelength) and PV2_3W (bandwidth).
    Points outside the control-point range give NaN."""

    _check_header(header)
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    psi_x = float(header.get("CRVAL1W", 1.0)) + float(header.get("CDELT1W", 1.0)) * (x + 1 - float(header["CRPIX1W"]))
    psi_y = float(header.get("CRVAL2W", 1.0)) + float(header.get("CDELT2W", 1.0)) * (y + 1 - float(header["CRPIX2W"]))
    ux = _fractional_index(psi_x, table.x)
    uy = _fractional_index(psi_y, table.y)
    ok = np.isfinite(ux) & np.isfinite(uy)
    ux0 = np.clip(np.floor(np.where(ok, ux, 0)), 0, table.x.size - 2).astype(int)  # left cell edge
    uy0 = np.clip(np.floor(np.where(ok, uy, 0)), 0, table.y.size - 2).astype(int)
    fx = np.where(ok, ux, 0) - ux0                                                   # 0..1 inside the cell
    fy = np.where(ok, uy, 0) - uy0
    v = table.values
    out = []
    for m in (0, 1):                       # PV1_3W = 1 -> component 0, PV2_3W = 2 -> component 1
        val = ((1 - fx) * (1 - fy) * v[uy0, ux0, m] + fx * (1 - fy) * v[uy0, ux0 + 1, m]
               + (1 - fx) * fy * v[uy0 + 1, ux0, m] + fx * fy * v[uy0 + 1, ux0 + 1, m])
        out.append(np.where(ok, val, np.nan))
    return out[0], out[1]


def grid_wavelength(header: fits.Header, table: WaveTable, wcs: WCS, grid: WCS, size_px: int) -> dict | None:
    """Wavelength of one exposure at every pixel of the display grid, as a plane.

    Each grid pixel centre goes grid pixel -> sky (grid WCS) -> this exposure's pixel (its
    celestial WCS, SIP included) -> wavelength_at(). Over a 25 x 25 px grid (2.6') the filter
    gradient is linear to well under 1e-4 um, so we keep a plane, in SCREEN pixels (row 0 = top,
    like the exported pixels):
        lambda(col, row) = wave[0] + wave[1] * (col - c) + wave[2] * (row - c),  c = (size_px - 1) / 2
    Returns {'wave': [l0, dl_dcol, dl_drow], 'bandwidth': median bandwidth (um),
             'resid': max |plane - exact| (um)}, or None if no grid pixel has a wavelength."""

    rows, cols = np.mgrid[:size_px, :size_px]               # screen pixel indices
    fits_rows = size_px - 1 - rows                          # grid WCS has row 0 at the bottom
    ra, dec = grid.pixel_to_world_values(cols.ravel(), fits_rows.ravel())
    x, y = wcs.world_to_pixel_values(ra, dec)               # 0-based pixels of this exposure
    lam, bw = wavelength_at(header, table, x, y)
    ok = np.isfinite(lam)
    if ok.sum() < 3:
        return None
    c = (size_px - 1) / 2
    A = np.column_stack([np.ones(ok.sum()), cols.ravel()[ok] - c, rows.ravel()[ok] - c])
    coef, *_ = np.linalg.lstsq(A, lam[ok], rcond=None)
    resid = float(np.max(np.abs(A @ coef - lam[ok])))
    return {"wave": [round(float(coef[0]), 5), round(float(coef[1]), 7), round(float(coef[2]), 7)],
            "bandwidth": round(float(np.nanmedian(bw)), 5), "resid": resid}


def exposure_wavelength(path, grid: WCS, size_px: int) -> dict | None:
    """grid_wavelength() for a cutout / L2 file on disk (or a file-like object). None if the
    file has no WCS-WAVE extension or no 'W' WCS."""
    import warnings

    from astropy.wcs import FITSFixedWarning

    if hasattr(path, "seek"):
        path.seek(0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        with fits.open(path) as h:
            img = h["IMAGE"] if "IMAGE" in h else h[1]
            if "CTYPE1W" not in img.header:
                return None
            name = str(img.header.get("PS1_0W", "WCS-WAVE")).strip()
            if name not in h:
                return None
            table = read_wave_table(h[name], img.header)
            return grid_wavelength(img.header, table, WCS(img.header).celestial, grid, size_px)
