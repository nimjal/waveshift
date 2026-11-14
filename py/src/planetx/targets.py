from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from astropy.coordinates import SkyCoord

MAS_PER_DEG = 3.6e6


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

        dt = year - self.ref_epoch
        dec = self.dec + self.pmdec * dt / MAS_PER_DEG
        ra = self.ra + self.pmra * dt / MAS_PER_DEG / np.cos(np.radians(self.dec))
        return SkyCoord(ra % 360.0, dec, unit="deg")

    def info(self) -> dict:
        """JSON-safe dict: id, name, kind, ra, dec, pmra, pmdec, ref_epoch (rounded floats)."""
        return {"id": self.id, "name": self.name, "kind": self.kind,
                "ra": round(self.ra, 6), "dec": round(self.dec, 6),
                "pmra": round(self.pmra, 2), "pmdec": round(self.pmdec, 2),
                "ref_epoch": self.ref_epoch}


def resolve(cfg: dict) -> Target:
    """One [[target]] table -> Target.
    If cfg has 'ra' and 'dec': use them (+ optional pmra, pmdec, ref_epoch; defaults 0, 0, 2000).
    Otherwise: from_simbad(cfg)."""

    if "ra" in cfg and "dec" in cfg:
        return Target(cfg["id"], cfg["name"], cfg.get("kind", ""),
                      float(cfg["ra"]), float(cfg["dec"]),
                      float(cfg.get("pmra", 0.0)), float(cfg.get("pmdec", 0.0)),
                      float(cfg.get("ref_epoch", 2000.0)))
    return from_simbad(cfg)


def _num(row, col) -> float:
    v = row[col]
    return 0.0 if np.ma.is_masked(v) else float(v)


def from_simbad(cfg: dict) -> Target:
    """Look up cfg.get('simbad', cfg['name']) in SIMBAD with extra fields pmra, pmdec.
    astroquery >= 0.4.8 returns lowercase 'ra'/'dec' in degrees; masked pm -> 0.
    SIMBAD positions are epoch J2000 -> ref_epoch=2000. Raise LookupError if not found."""

    from astroquery.simbad import Simbad

    s = Simbad()
    s.add_votable_fields("pmra", "pmdec")
    lookup = cfg.get("simbad", cfg["name"])
    t = s.query_object(lookup)
    if t is None or len(t) == 0:
        raise LookupError(f"SIMBAD could not resolve {lookup!r}")
    row = t[0]
    cols = {c.lower(): c for c in t.colnames}
    try:
        ra, dec = float(row[cols["ra"]]), float(row[cols["dec"]])
    except (KeyError, ValueError):  # older astroquery: sexagesimal strings
        c = SkyCoord(row[cols["ra"]], row[cols["dec"]], unit=("hourangle", "deg"))
        ra, dec = c.ra.deg, c.dec.deg
    pmra = _num(row, cols["pmra"]) if "pmra" in cols else 0.0
    pmdec = _num(row, cols["pmdec"]) if "pmdec" in cols else 0.0
    return Target(cfg["id"], cfg["name"], cfg.get("kind", ""), ra, dec, pmra, pmdec, 2000.0)


def adhoc(ra: float, dec: float) -> Target:
    """A user-entered position (live API): zero proper motion.
    id like 'pos_133.7951_-7.2451', name like 'RA 133.7951, Dec -7.2451', kind 'custom'."""
    
    return Target(f"pos_{ra:.4f}_{dec:+.4f}", f"RA {ra:.4f}, Dec {dec:+.4f}", "custom", ra, dec)
