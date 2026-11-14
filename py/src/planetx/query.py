"""Which SPHEREx images cover a position, grouped into epochs."""
from __future__ import annotations

import time
import warnings
from concurrent.futures import ThreadPoolExecutor

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.table import Table, unique, vstack
from astropy.time import Time

# Columns kept from the SIA result (everything else is dropped).
KEEP = ["obs_id", "access_url", "energy_bandpassname", "t_min", "t_max",
        "em_min", "em_max", "s_pixel_scale", "dataproduct_subtype", "obs_collection",
        "s_ra", "s_dec"]  # image centre: used to rank exposures by coverage
STR_COLS = {"obs_id", "access_url", "energy_bandpassname", "dataproduct_subtype", "obs_collection"}


def detector_of(bandpass: str) -> str:
    """'SPHEREx-D3' -> 'D3'."""
    return str(bandpass).rsplit("-", 1)[-1]


def _clean(t: Table) -> Table:
    """KEEP columns only, cast to plain str/float (masked/None -> nan) so vstack works."""
    out = Table()
    for c in KEEP:
        col = t[c] if c in t.colnames else [None] * len(t)
        if c in STR_COLS:
            out[c] = np.array([str(v) for v in col], dtype=str)
        else:
            out[c] = np.array([np.nan if np.ma.is_masked(v) or v is None else float(v)
                               for v in col], dtype=float)
    return out


def empty() -> Table:
    """A zero-row Table with the KEEP columns + 'detector' (str cols as str, others float)."""
    t = Table()
    for c in KEEP:
        t[c] = np.array([], dtype=str if c in STR_COLS else float)
    t["detector"] = np.array([], dtype=str)
    return t


def find_images(coord: SkyCoord, collections: list[str],
                radius: u.Quantity = 3 * u.arcsec) -> Table:
    """Irsa.query_sia(pos=(coord, radius), collection=c) for each collection.
    - skip collections that return nothing (qr3 often lags) — never fail on that
    - keep only KEEP columns, cast to plain str/float (masked -> nan) so vstack works
    - keep dataproduct_subtype == 'science'
    - add 'detector' via detector_of(energy_bandpassname)
    - dedupe on (obs_id, detector)
    Returns empty() if nothing anywhere."""
    from astroquery.ipac.irsa import Irsa

    def one(coll: str):
        for attempt in range(2):  # IRSA occasionally drops a connection; retry once
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    return Irsa.query_sia(pos=(coord, radius), collection=coll)
            except Exception:  # noqa: BLE001
                if attempt:
                    raise
                time.sleep(1.0)

    # collections in parallel: the slowest one sets the latency, not the sum
    with ThreadPoolExecutor(max_workers=max(1, len(collections))) as ex:
        results = list(ex.map(one, collections))
    parts = [_clean(Table(t)) for t in results if t is not None and len(t)]
    if not parts:
        return empty()
    t = vstack(parts) if len(parts) > 1 else parts[0]
    t = t[t["dataproduct_subtype"] == "science"]
    t["detector"] = np.array([detector_of(b) for b in t["energy_bandpassname"]], dtype=str)
    if len(t):
        t = unique(t, keys=["obs_id", "detector"])
    return t


def assign_epochs(images: Table, gap_days: float = 30.0) -> Table:
    """Return a copy sorted by t_min with int column 'epoch' (0, 1, 2 ...):
    a gap in t_min larger than gap_days starts a new epoch. Empty in -> empty out."""
    t = images.copy()
    if len(t) == 0:
        t["epoch"] = np.array([], dtype=int)
        return t
    t.sort("t_min")
    gaps = np.diff(np.asarray(t["t_min"], dtype=float)) > gap_days
    t["epoch"] = np.concatenate([[0], np.cumsum(gaps)]).astype(int)
    return t


def epoch_summary(images: Table) -> list[dict]:
    """One dict per epoch, in order, with keys:
    index (int), id ('A','B',...), label (mid-date as 'May 2025'),
    mjd_start (min t_min), mjd_end (max t_max), year_mid (decimal year), n_images."""
    out = []
    for ep in np.unique(images["epoch"]):
        rows = images[images["epoch"] == ep]
        lo, hi = float(np.min(rows["t_min"])), float(np.max(rows["t_max"]))
        mid = Time((lo + hi) / 2, format="mjd")
        out.append({
            "index": int(ep),
            "id": chr(ord("A") + int(ep)),
            "label": mid.datetime.strftime("%b %Y"),
            "mjd_start": round(lo, 4),
            "mjd_end": round(hi, 4),
            "year_mid": round(float(mid.decimalyear), 4),
            "n_images": int(len(rows)),
        })
    return out


def detector_ranges(images: Table) -> dict[str, list[float]]:
    """{'D1': [min em_min, max em_max], ...} in MICRONS (metres * 1e6), rounded to 3 dp."""
    out = {}
    for det in sorted(set(images["detector"])):
        rows = images[images["detector"] == det]
        out[str(det)] = [round(float(np.nanmin(rows["em_min"])) * 1e6, 3),
                         round(float(np.nanmax(rows["em_max"])) * 1e6, 3)]

    return out
