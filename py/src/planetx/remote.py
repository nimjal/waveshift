"""Read a small window of a SPHEREx L2 image straight from IRSA with HTTP range requests.

The IRSA cutout service ships every extension (PSF cube included, ~4 MB) and takes
3-10 s per cutout. A 39x39 window only needs ~300 KB of IMAGE rows, a few KB of
compressed FLAGS tiles and ZODI rows, so we read those byte ranges ourselves.

Layout of a SPHEREx L2 MEF (checked on dr1 / qr3):
  0 PRIMARY (no data) · 1 IMAGE f32 · 2 FLAGS (RICE tile-compressed int32, one row per tile)
  3 VARIANCE f32 · 4 ZODI f32 · 5 EPSF · 6 WCS-WAVE
Anything unexpected raises UnsupportedLayout so the caller can fall back to the cutout service.
"""
from __future__ import annotations

import io
import math
import time
import warnings
from concurrent.futures import ThreadPoolExecutor

import httpx
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import FITSFixedWarning, WCS

BLOCK = 2880
CARD = 80
END_CARD = b"END" + b" " * 77
RETRY_STATUS = {429, 500, 502, 503, 504}


class DeadlineExceeded(Exception):
    """Ran out of time budget. Transient: try again on the next call."""


class Unavailable(Exception):
    """Server kept answering 503/429/timeout until the deadline. Transient."""


class UnsupportedLayout(Exception):
    """The file isn't laid out the way this reader expects."""


class NoCoverage(Exception):
    """The requested window doesn't intersect the image."""


def _pad(n: int) -> int:
    return -(-n // BLOCK) * BLOCK


class RemoteFits:
    """Byte-range reader for one FITS file, with deadline-aware retries."""

    def __init__(self, client: httpx.Client, url: str, deadline: float, retries: int = 4):
        self.client, self.url, self.deadline, self.retries = client, url, deadline, retries

    def read(self, start: int, stop: int) -> bytes:
        """Bytes [start, stop). Retries 429/5xx/timeouts with 0.5, 1, 2 ... s backoff,
        never past the deadline."""

        for attempt in range(self.retries + 1):
            left = self.deadline - time.monotonic()

            if left <= 0.2:
                raise DeadlineExceeded(self.url)
            try:
                r = self.client.get(self.url, headers={"Range": f"bytes={start}-{stop - 1}"},
                                    timeout=httpx.Timeout(min(10.0, left), connect=min(5.0, left)))
            except httpx.TimeoutException:
                r = None
            if r is not None and r.status_code not in RETRY_STATUS:
                r.raise_for_status()
                if r.status_code != 206:
                    raise UnsupportedLayout(f"server ignored Range (HTTP {r.status_code})")
                return r.content
            pause = min(0.5 * 2 ** attempt, self.deadline - time.monotonic() - 0.2)
            if attempt == self.retries or pause <= 0:
                break
            time.sleep(pause)

        raise Unavailable(self.url)

    def header(self, off: int, prefetch: int = BLOCK * 8) -> tuple[fits.Header, int, bytes]:
        """Header starting at byte `off` -> (header, padded header length, raw bytes read).
        The raw bytes may run past the header (handy when the data follows)."""

        buf = self.read(off, off + prefetch)

        while True:
            found = parse_header(buf)
            if found:
                return found[0], found[1], buf
            if len(buf) > BLOCK * 200:
                raise UnsupportedLayout("no END card in header")
            
            buf += self.read(off + len(buf), off + len(buf) + prefetch)


def parse_header(buf: bytes) -> tuple[fits.Header, int] | None:
    """(header, padded length) if buf holds a complete header from its first byte."""

    for i in range(0, len(buf) - CARD + 1, CARD):
        if buf[i:i + CARD] == END_CARD:
            return fits.Header.fromstring(buf[:i + CARD].decode("ascii")), _pad(i + CARD)
    return None


def _data_size(h: fits.Header) -> int:

    n = h.get("NAXIS", 0)
    if n == 0:
        return 0
    size = abs(h["BITPIX"]) // 8 * math.prod(h[f"NAXIS{i}"] for i in range(1, n + 1))
    return _pad(size + h.get("PCOUNT", 0))


def _image_rows(rf: RemoteFits, h: fits.Header, data_off: int,
                y0: int, y1: int, x0: int, x1: int) -> np.ndarray:
    """Rows y0..y1 (inclusive, 0-based) of an uncompressed float image, cols x0..x1."""

    if h.get("BITPIX") != -32 or h.get("NAXIS") != 2:
        raise UnsupportedLayout(f"{h.get('EXTNAME')}: BITPIX={h.get('BITPIX')}")
    nx = h["NAXIS1"]
    row = 4 * nx
    raw = rf.read(data_off + y0 * row, data_off + (y1 + 1) * row)
    a = np.frombuffer(raw, dtype=">f4").reshape(y1 - y0 + 1, nx)[:, x0:x1 + 1].astype(float)
    return a * h.get("BSCALE", 1.0) + h.get("BZERO", 0.0)


def _flag_rows(rf: RemoteFits, h: fits.Header, data_off: int, head: bytes, hlen: int,
               y0: int, y1: int, x0: int, x1: int) -> tuple[np.ndarray, fits.Header]:
    """Decode rows y0..y1 of the RICE tile-compressed FLAGS extension.
    Reads the tile descriptors + just the heap bytes of those tiles, rebuilds a tiny
    compressed HDU in memory and lets astropy decompress it."""

    if not h.get("ZIMAGE") or h.get("TFIELDS") != 1 or h.get("NAXIS1") != 8 \
            or not str(h.get("TFORM1", "")).startswith("1P") \
            or h.get("ZTILE1") != h.get("ZNAXIS1"):
        raise UnsupportedLayout("FLAGS is not one-P-column row-tiled")
    
    zt2 = int(h.get("ZTILE2", 1))
    t0, t1 = y0 // zt2, y1 // zt2
    ntab = 8 * h["NAXIS2"]

    # descriptor table (usually already in the bytes read with the header)
    tab = head[hlen:hlen + ntab]
    if len(tab) < (t1 + 1) * 8:
        tab = rf.read(data_off, data_off + ntab)
    desc = np.frombuffer(tab[t0 * 8:(t1 + 1) * 8], dtype=">i4").reshape(-1, 2)  # (count, offset)
    heap_off = data_off + int(h.get("THEAP", ntab))
    lo, hi = int(desc[:, 1].min()), int((desc[:, 1] + desc[:, 0]).max())
    heap = rf.read(heap_off + lo, heap_off + hi)

    nt = t1 - t0 + 1
    rows = min(h["ZNAXIS2"], (t1 + 1) * zt2) - t0 * zt2
    newdesc = desc.copy()
    newdesc[:, 1] -= lo
    nh = h.copy()

    for k in ("THEAP", "CHECKSUM", "DATASUM", "ZHECKSUM", "ZDATASUM"):
        nh.remove(k, ignore_missing=True)

    nh["NAXIS2"] = nt
    nh["PCOUNT"] = len(heap)
    nh["ZNAXIS2"] = rows
    data = newdesc.astype(">i4").tobytes() + heap
    blob = (fits.PrimaryHDU().header.tostring().encode("ascii")
            + nh.tostring().encode("ascii")
            + data + b"\0" * (_pad(len(data)) - len(data)))
    
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with fits.open(io.BytesIO(blob)) as hd:
            comp = hd[1]
            arr = np.array(comp.data)
            ihdr = comp.header.copy()

    off = y0 - t0 * zt2
    return arr[off:off + (y1 - y0 + 1), x0:x1 + 1], ihdr


# WCS-WAVE tables by spectral-WCS calibration id (spectral.calib_id). The table depends on
# detector + calibration only, so each is fetched once per process.
_WAVE_TABLES: dict[str, object] = {}
_WAVE_LOCK = __import__("threading").Lock()   # one header walk per table, not one per worker


def _find_hdu(rf: RemoteFits, off: int, name: str, max_hops: int = 8) -> tuple[fits.Header, int, bytes, int]:
    """Walk extension headers from byte `off` until EXTNAME == name ->
    (header, padded header length, raw bytes read from the header start, header offset)."""
    for _ in range(max_hops):
        h, hl, raw = rf.header(off, prefetch=BLOCK * 6)
        if str(h.get("EXTNAME", "")).strip() == name:
            return h, hl, raw, off
        off += hl + _data_size(h)
    raise UnsupportedLayout(f"no {name} extension within {max_hops} HDUs")


def _wave_table(rf: RemoteFits, h1: fits.Header, after_off: int):
    """The WCS-WAVE table for this file (spectral.WaveTable), from the cache when its
    calibration id was seen before; else read with range requests, walking the headers from
    `after_off` (any HDU boundary before WCS-WAVE)."""
    from . import spectral

    cid = spectral.calib_id(h1)
    if cid and cid in _WAVE_TABLES:
        return _WAVE_TABLES[cid]
    with _WAVE_LOCK:
        return _wave_table_locked(rf, h1, after_off, cid)


def _wave_table_locked(rf: RemoteFits, h1: fits.Header, after_off: int, cid: str | None):
    from . import spectral

    if cid and cid in _WAVE_TABLES:          # another worker fetched it while we waited
        return _WAVE_TABLES[cid]
    disk = None
    if cid:
        from .config import cache_dir
        disk = cache_dir() / "wave" / f"{cid}.npz"
        try:
            with np.load(disk) as z:
                _WAVE_TABLES[cid] = spectral.WaveTable(z["x"], z["y"], z["values"])
                return _WAVE_TABLES[cid]
        except (OSError, ValueError, KeyError):
            pass
    name = str(h1.get("PS1_0W", "WCS-WAVE")).strip()
    hw, lw, raw, off = _find_hdu(rf, after_off, name)
    need = lw + _data_size(hw)
    if len(raw) < need:
        raw = raw + rf.read(off + len(raw), off + need)
    blob = fits.PrimaryHDU().header.tostring().encode("ascii") + raw[:need]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with fits.open(io.BytesIO(blob)) as hd:
            table = spectral.read_wave_table(hd[1], h1)
    if cid:
        _WAVE_TABLES[cid] = table
        try:
            disk.parent.mkdir(parents=True, exist_ok=True)
            tmp = disk.with_suffix(".part.npz")
            with open(tmp, "wb") as fh:
                np.savez(fh, x=table.x, y=table.y, values=table.values)
            tmp.replace(disk)
        except OSError:
            pass
    return table


def read_window(client: httpx.Client, url: str, coord: SkyCoord, half: int, deadline: float,
                bad_flags: list[str] | None = None, subtract_zodi: bool = True, wave: bool = False,
                ) -> tuple:
    """A (2*half+1)^2 window of IMAGE (- ZODI) centred on `coord`, flagged pixels -> NaN,
    plus its celestial WCS. Same result as load_cutout() on an IRSA cutout of that area.
    wave=True adds a third item: (window header, spectral.WaveTable) for spectral.wavelength_at
    / grid_wavelength (CRPIXjW shifted to the window like CRPIXj), or None if unavailable.
    Raises NoCoverage, UnsupportedLayout, Unavailable, DeadlineExceeded, httpx errors."""

    from .stack import bad_mask

    rf = RemoteFits(client, url, deadline)
    h0, l0, raw = rf.header(0, prefetch=BLOCK * 16)
    img_off = l0 + _data_size(h0)
    found = parse_header(raw[img_off:])  # usually already in the first read
    h1, l1 = found if found else rf.header(img_off)[:2]
    if h1.get("EXTNAME") != "IMAGE":
        raise UnsupportedLayout(f"HDU 1 is {h1.get('EXTNAME')!r}, not IMAGE")
    img_data = img_off + l1

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        wcs_full = WCS(h1).celestial
    nx, ny = h1["NAXIS1"], h1["NAXIS2"]
    cx, cy = (float(v) for v in wcs_full.world_to_pixel(coord))
    if not (np.isfinite(cx) and np.isfinite(cy)):
        raise NoCoverage(url)
    x0, y0 = int(round(cx)) - half, int(round(cy)) - half
    x1, y1 = x0 + 2 * half, y0 + 2 * half
    x0c, y0c, x1c, y1c = max(0, x0), max(0, y0), min(nx - 1, x1), min(ny - 1, y1)
    if x0c > x1c or y0c > y1c:
        raise NoCoverage(url)

    flags_off = img_data + _data_size(h1)
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_img = ex.submit(_image_rows, rf, h1, img_data, y0c, y1c, x0c, x1c)
        # FLAGS header + descriptor table in one read
        hf, lf, headf = rf.header(flags_off, prefetch=BLOCK * 16)
        if hf.get("EXTNAME") != "FLAGS":
            raise UnsupportedLayout(f"HDU 2 is {hf.get('EXTNAME')!r}, not FLAGS")
        f_flags = ex.submit(_flag_rows, rf, hf, flags_off + lf, headf, lf, y0c, y1c, x0c, x1c) \
            if bad_flags else None
        zodi = None
        if subtract_zodi:
            var_off = flags_off + lf + _data_size(hf)
            hv, lv, _ = rf.header(var_off, prefetch=BLOCK * 6)
            z_off = var_off + lv + _data_size(hv)
            hz, lz, _ = rf.header(z_off, prefetch=BLOCK * 6)
            if hz.get("EXTNAME") == "ZODI":
                zodi = _image_rows(rf, hz, z_off + lz, y0c, y1c, x0c, x1c)
        data = f_img.result()
        if zodi is not None:
            data = data - zodi
        if f_flags is not None:
            flags, fhdr = f_flags.result()
            data[bad_mask(flags, fhdr, bad_flags)] = np.nan

    win = h1.copy()
    win["NAXIS1"], win["NAXIS2"] = x1c - x0c + 1, y1c - y0c + 1
    win["CRPIX1"] = h1["CRPIX1"] - x0c
    win["CRPIX2"] = h1["CRPIX2"] - y0c
    if "CRPIX1W" in win:    # spectral lookup table: same shift (window pixel 1 = full pixel x0c + 1)
        win["CRPIX1W"] = h1["CRPIX1W"] - x0c
        win["CRPIX2W"] = h1["CRPIX2W"] - y0c

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        wcs = WCS(win).celestial
    if not wave:
        return data, wcs
    spec = None
    if "CTYPE1W" in h1:
        try:
            spec = (win, _wave_table(rf, h1, flags_off + lf + _data_size(hf)))   # walk starts after FLAGS
        except (UnsupportedLayout, ValueError, KeyError, DeadlineExceeded, Unavailable, httpx.HTTPError) as e:
            import logging
            logging.getLogger(__name__).info("no spectral table for %s: %s", url, e)
    return data, wcs, spec
