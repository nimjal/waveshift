"""Targets: name -> position + proper motion, and position at any date.

Barnard's Star moves ~10"/yr: its J2000 position is ~4' off in 2025, outside a
small cutout. Every position must be propagated to the observation epoch.
"""
from __future__ import annotations

from dataclasses import dataclass

from astropy.coordinates import SkyCoord


@dataclass
class Target:
    id: str
    name: str
    kind: str
    ra: float           # deg, at ref_epoch
    dec: float          # deg, at ref_epoch
    pmra: float = 0.0   # mas/yr, ALREADY multiplied by cos(dec) (SIMBAD convention)
    pmdec: float = 0.0  # mas/yr
    ref_epoch: float = 2000.0

    def at(self, year: float) -> SkyCoord:
        """Position at decimal `year` by linear proper motion:
        dDec = pmdec*dt, dRA = pmra*dt / cos(dec)   (mas -> deg: / 3.6e6).
        Wrap RA into [0, 360). Return a SkyCoord in degrees."""
        raise NotImplementedError

    def info(self) -> dict:
        """JSON-safe dict: id, name, kind, ra, dec, pmra, pmdec, ref_epoch (rounded floats)."""
        raise NotImplementedError


def resolve(cfg: dict) -> Target:
    """One [[target]] table -> Target.
    If cfg has 'ra' and 'dec': use them (+ optional pmra, pmdec, ref_epoch; defaults 0, 0, 2000).
    Otherwise: from_simbad(cfg)."""
    raise NotImplementedError


def from_simbad(cfg: dict) -> Target:
    """Look up cfg.get('simbad', cfg['name']) in SIMBAD with extra fields pmra, pmdec.
    astroquery >= 0.4.8 returns lowercase 'ra'/'dec' in degrees; masked pm -> 0.
    SIMBAD positions are epoch J2000 -> ref_epoch=2000. Raise LookupError if not found."""
    raise NotImplementedError


def adhoc(ra: float, dec: float) -> Target:
    """A user-entered position (live API): zero proper motion.
    id like 'pos_133.7951_-7.2451', name like 'RA 133.7951, Dec -7.2451', kind 'custom'."""
    raise NotImplementedError
