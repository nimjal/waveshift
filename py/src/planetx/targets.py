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


SIMBAD_SERVERS = ("simbad.cds.unistra.fr", "simbad.harvard.edu")  # main (Strasbourg), then mirror


def _simbad_query(lookup: str):
    """query_object(lookup) with pmra/pmdec, trying each server in SIMBAD_SERVERS.
    Falls through to the next server only on errors (network/HTTP/TAP); an empty
    result ("not found") is returned as-is. If all fail: ConnectionError chained to the last error."""

    import warnings

    from astroquery.simbad import Simbad

    last_err: Exception | None = None
    for server in SIMBAD_SERVERS:
        s = Simbad()
        s.server = server
        try:
            s.add_votable_fields("pmra", "pmdec")  # hits the server too (lists TAP fields)
            return s.query_object(lookup)
        except Exception as e:  # ConnectionError, Timeout, HTTPError, DALServiceError, ...
            last_err = e
            warnings.warn(f"SIMBAD server {server} failed ({type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}); "
                          "trying next mirror", RuntimeWarning, stacklevel=2)
    raise ConnectionError(f"all SIMBAD servers failed for {lookup!r}") from last_err


def from_simbad(cfg: dict) -> Target:
    """Look up cfg.get('simbad', cfg['name']) in SIMBAD with extra fields pmra, pmdec.
    astroquery >= 0.4.8 returns lowercase 'ra'/'dec' in degrees; masked pm -> 0.
    SIMBAD positions are epoch J2000 -> ref_epoch=2000. Raise LookupError if not found."""

    lookup = cfg.get("simbad", cfg["name"])
    t = _simbad_query(lookup)
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


# --- name lookup for the live API (GET /resolve) --------------------------------------
# CDS Sesame (SIMBAD, then NED / VizieR) over HTTP, Strasbourg first, then the Harvard
# mirror. Called from the API only, never from the browser. Curated targets are matched
# first: their config holds SIMBAD values plus aliases Sesame doesn't know
# ("WISE 0855-0714" is not a SIMBAD identifier).
SESAME_SERVERS = ("https://cds.unistra.fr/cgi-bin/nph-sesame",
                  "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame")


def _norm(s: str) -> str:
    """'WISE 0855−0714' -> 'wise0855-0714': lowercase, no spaces, unicode minus -> '-'."""
    return "".join(str(s).lower().replace("−", "-").split())


def _curated_match(name: str, cfgs: list[dict]) -> dict | None:
    """A curated target whose id, name or simbad alias equals `name` (normalised), or starts
    with it when that prefix is unique and >= 4 characters ('WISE 0855' -> 'WISE 0855-0714')."""
    q = _norm(name)
    if not q:
        return None
    keys = [(c, [_norm(c.get(k, "")) for k in ("id", "name", "simbad")]) for c in cfgs]
    exact = [c for c, ks in keys if q in ks]
    if exact:
        return exact[0]
    prefix = [c for c, ks in keys if len(q) >= 4 and any(k.startswith(q) for k in ks if k)]
    return prefix[0] if len(prefix) == 1 else None


def parse_sesame(xml: str) -> dict | None:
    """First resolver hit in a Sesame -oxp reply -> {name, ra, dec, pmra, pmdec, otype,
    resolver}; None when Sesame says nothing was found. Positions are J2000 degrees
    (jradeg/jdedeg); pmRA is mas/yr including cos(dec), pmDE mas/yr; absent pm -> 0."""
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml)
    for res in root.iter("Resolver"):
        ra, dec = res.findtext("jradeg"), res.findtext("jdedeg")
        if ra is None or dec is None:
            continue
        pm = res.find("pm")
        num = lambda tag: float(pm.findtext(tag)) if pm is not None and pm.findtext(tag) else 0.0
        return {"name": (res.findtext("oname") or "").strip(), "ra": float(ra), "dec": float(dec),
                "pmra": num("pmRA"), "pmdec": num("pmDE"),
                "otype": (res.findtext("otype") or "").strip(),
                "resolver": res.get("name", "").split(",")[0].strip()}
    return None


def sesame(name: str, timeout: float = 8.0) -> dict | None:
    """Resolve `name` with Sesame, trying each SESAME_SERVERS entry on network/HTTP/XML
    errors. 'Nothing found' is an answer (None), not an error. All servers failing ->
    ConnectionError chained to the last error."""
    from urllib.parse import quote

    import httpx

    last: Exception | None = None
    for base in SESAME_SERVERS:
        try:
            r = httpx.get(f"{base}/-oxp/SNV?{quote(name)}", timeout=timeout, follow_redirects=True)
            r.raise_for_status()
            return parse_sesame(r.text)
        except Exception as e:  # noqa: BLE001 — timeout, HTTP error, HTML error page ...
            last = e
    raise ConnectionError(f"Sesame unavailable for {name!r}") from last


def resolve_name(name: str, epoch: float, cfgs: list[dict] | None = None) -> dict | None:
    """Object name -> {query, name, source, ra, dec, pmra, pmdec, ra_epoch, dec_epoch, epoch,
    curated_id}. `ra`/`dec` are J2000 (ref position); `ra_epoch`/`dec_epoch` are moved to
    `epoch` (the grid epoch) with Target.at, which is what a live query should centre on:
    a fast mover like WISE 0855 is ~3.5' from its J2000 position by 2025.9.
    None = not found anywhere. Raises ConnectionError if Sesame is unreachable."""
    cfg = _curated_match(name, cfgs or [])
    if cfg is not None and "ra" in cfg and "dec" in cfg:
        t = resolve(cfg)
        source, curated_id = "curated target list (SIMBAD values)", cfg["id"]
    else:
        hit = sesame(name)
        if hit is None:
            return None
        t = Target("", hit["name"] or name, hit["otype"], hit["ra"], hit["dec"],
                   hit["pmra"], hit["pmdec"], 2000.0)
        source, curated_id = f"CDS Sesame ({hit['resolver'] or 'Simbad'})", None
    now = t.at(epoch)
    return {"query": name, "name": t.name, "source": source, "curated_id": curated_id,
            "ra": round(t.ra, 6), "dec": round(t.dec, 6),
            "pmra": round(t.pmra, 2), "pmdec": round(t.pmdec, 2),
            "epoch": epoch, "ra_epoch": round(now.ra.deg, 6), "dec_epoch": round(now.dec.deg, 6)}
