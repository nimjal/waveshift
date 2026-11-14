"""Which SPHEREx images cover a position, grouped into epochs."""
from __future__ import annotations

import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.table import Table

# Columns kept from the SIA result (everything else is dropped).
KEEP = ["obs_id", "access_url", "energy_bandpassname", "t_min", "t_max",
        "em_min", "em_max", "s_pixel_scale", "dataproduct_subtype", "obs_collection"]


def detector_of(bandpass: str) -> str:
    """'SPHEREx-D3' -> 'D3'."""
    raise NotImplementedError


def empty() -> Table:
    """A zero-row Table with the KEEP columns + 'detector' (str cols as str, others float)."""
    raise NotImplementedError


def find_images(coord: SkyCoord, collections: list[str],
                radius: u.Quantity = 3 * u.arcsec) -> Table:
    """Irsa.query_sia(pos=(coord, radius), collection=c) for each collection.
    - skip collections that return nothing (qr3 often lags) — never fail on that
    - keep only KEEP columns, cast to plain str/float (masked -> nan) so vstack works
    - keep dataproduct_subtype == 'science'
    - add 'detector' via detector_of(energy_bandpassname)
    - dedupe on (obs_id, detector)
    Returns empty() if nothing anywhere."""
    raise NotImplementedError


def assign_epochs(images: Table, gap_days: float = 30.0) -> Table:
    """Return a copy sorted by t_min with int column 'epoch' (0, 1, 2 ...):
    a gap in t_min larger than gap_days starts a new epoch. Empty in -> empty out."""
    raise NotImplementedError


def epoch_summary(images: Table) -> list[dict]:
    """One dict per epoch, in order, with keys:
    index (int), id ('A','B',...), label (mid-date as 'May 2025'),
    mjd_start (min t_min), mjd_end (max t_max), year_mid (decimal year), n_images."""
    raise NotImplementedError


def detector_ranges(images: Table) -> dict[str, list[float]]:
    """{'D1': [min em_min, max em_max], ...} in MICRONS (metres * 1e6), rounded to 3 dp."""
    raise NotImplementedError
