"""Why a pixel is blank: ONE implementation shared by the curated build (stack.py / pipeline.py)
and the live path (live.py). docs/schema.md "Blank-pixel reasons".

Categories, their codes, labels, priority and FLAGS planes come from sources.toml [reasons].
Plane names/bits are read from each file's FLAGS header (MSKNnnnn = name), never hardcoded.

Only BLANK (NaN) pixels get a reason; a finite pixel is valid (code 0) even if a flag bit is set
on it (e.g. OVERFLOW = onset of nonlinearity, not clipping).

Three levels, one rule ("highest priority wins", `merge`):
  native   each blank native pixel -> the highest-priority category whose plane is set
           (a [flags].bad plane in no named category -> other_flag, plane name kept),
           else unexplained.
  frame    reprojected like the data: a blank output pixel inside the footprint takes the
           highest-priority native reason in its bilinear stencil; outside it -> not_observed.
  stack    a stacked pixel is blank only if every exposure is blank there; it takes the
           highest-priority reason over ALL exposures, including ones dropped from the stack
           because they are entirely blank (so a fully masked epoch is never not_observed).
not_observed ranks below every observed reason: one exposure that missed a pixel must not
hide another exposure's reason for it.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np

log = logging.getLogger(__name__)

VALID = 0
NOT_OBSERVED, UNEXPLAINED, OTHER_FLAG, SATURATED = "not_observed", "unexplained", "other_flag", "saturated"
_REQUIRED = (SATURATED, NOT_OBSERVED, UNEXPLAINED, OTHER_FLAG)


@dataclass(frozen=True)
class Category:
    key: str
    code: int
    label: str
    planes: tuple[str, ...]
    rank: int            # 0 = highest priority


@dataclass
class Table:
    """The reason table from sources.toml. `rank_of[code]` -> priority (lower wins);
    code 0 (valid / nothing seen) ranks below everything, so it is the identity of `merge`."""
    categories: list[Category]
    bad: tuple[str, ...]                       # [flags].bad: the planes that blank pixels
    rank_of: np.ndarray = field(init=False)    # indexed by code (0..9)

    def __post_init__(self):
        r = np.full(10, 255, np.uint8)
        for c in self.categories:
            r[c.code] = c.rank
        self.rank_of = r

    def code(self, key: str) -> int:
        return next(c.code for c in self.categories if c.key == key)

    def other_planes(self) -> list[str]:
        """Planes attributed as other_flag (by name): the other_flag category's own `planes`,
        plus every [flags].bad plane that no other category claims."""
        own = [p for c in self.categories if c.key == OTHER_FLAG for p in c.planes]
        named = {p for c in self.categories if c.key != OTHER_FLAG for p in c.planes}
        return list(dict.fromkeys(own + [p for p in self.bad if p not in named]))

    def to_json(self) -> dict:
        """{code: {key, label, rank}} for the frontend (code 0 = valid, no rank)."""
        out = {"0": {"key": "valid", "label": "Valid"}}
        for c in self.categories:
            out[str(c.code)] = {"key": c.key, "label": c.label, "rank": c.rank}
        return out


def load_table(sources: dict) -> Table:
    """sources['reasons']['category'] (array of tables, PRIORITY ORDER, highest first) +
    sources['flags']['bad']. Validates: unique single-digit codes 1-9, saturated = 1 (motion /
    photometry / web depend on it), not_observed / unexplained / other_flag present,
    not_observed last."""
    cats = sources.get("reasons", {}).get("category", [])
    out = [Category(c["key"], int(c["code"]), c["label"], tuple(c.get("planes", [])), i)
           for i, c in enumerate(cats)]
    codes = [c.code for c in out]
    keys = [c.key for c in out]
    if len(set(codes)) != len(codes) or not all(1 <= c <= 9 for c in codes):
        raise ValueError(f"[reasons] codes must be unique digits 1-9, got {codes}")
    if missing := [k for k in _REQUIRED if k not in keys]:
        raise ValueError(f"[reasons] missing categories {missing}")
    if out[[c.key for c in out].index(SATURATED)].code != 1:
        raise ValueError("[reasons] saturated must keep code 1")
    if keys[-1] != NOT_OBSERVED:
        raise ValueError("[reasons] not_observed must be last (lowest priority)")
    t = Table(out, tuple(sources.get("flags", {}).get("bad", [])))
    if t.other_planes():
        log.info("bad planes not in a named reason category (-> other_flag): %s", t.other_planes())
    return t


@dataclass
class Reasons:
    """Per-pixel reason codes (uint8, 0 = valid / nothing to say) + the plane behind each
    other_flag pixel ('' elsewhere)."""
    codes: np.ndarray
    names: np.ndarray

    @classmethod
    def empty(cls, shape) -> "Reasons":
        return cls(np.zeros(shape, np.uint8), np.full(shape, "", dtype=object))


# ------------------------------------------------------------------------------ native

def native(data: np.ndarray, flags: np.ndarray | None, bits: dict[str, int], table: Table) -> Reasons:
    """Reason for every blank native pixel of `data` (already masked with [flags].bad).
    flags/bits = raw FLAGS array and stack.flag_bits(header); None/{} -> every blank is
    unexplained."""
    blank = ~np.isfinite(data)
    r = Reasons.empty(data.shape)
    left = blank.copy()
    if flags is not None and bits and left.any():
        f = np.asarray(flags, np.int64)
        for c in table.categories:
            if c.key == OTHER_FLAG:
                for name in table.other_planes():
                    if name in bits:
                        m = left & (((f >> bits[name]) & 1) != 0)
                        r.codes[m], r.names[m] = c.code, name
                        left &= ~m
                continue
            val = 0
            for name in c.planes:
                if name in bits:
                    val |= 1 << bits[name]
            if val:
                m = left & ((f & val) != 0)
                r.codes[m] = c.code
                left &= ~m
    r.codes[left] = table.code(UNEXPLAINED)
    return r


# ------------------------------------------------------------------------------- frame

def frame(nat: Reasons, wcs, out: np.ndarray, grid, size_px: int, table: Table) -> Reasons:
    """Native reasons -> output grid, through the SAME bilinear reproject_interp as the data.
    For each reason (and each other_flag plane) an indicator that is NaN on that reason's
    native pixels and 0 elsewhere is reprojected: it blanks exactly the output pixels whose
    stencil the data's NaNs blank (zero-weight neighbours included). `out` = the data on the
    grid (NaN = blank). Blank output: outside the footprint -> not_observed; else the
    highest-priority reason touched; nothing touched (cannot happen while every native NaN
    has a reason) -> unexplained."""
    from reproject import reproject_interp

    shape = (size_px, size_px)
    res = Reasons.empty(shape)
    blank_out = ~np.isfinite(out)
    if not blank_out.any():
        return res
    layers: list[tuple[int, str]] = []        # (code, plane name for other_flag)
    present = set(np.unique(nat.codes).tolist()) - {VALID}
    for c in table.categories:
        if c.code not in present:
            continue
        if c.key == OTHER_FLAG:
            layers += [(c.code, n) for n in dict.fromkeys(nat.names[nat.codes == c.code].tolist())]
        else:
            layers.append((c.code, ""))
    # layer 0 has no NaN: its footprint is the geometric coverage. (reproject's footprint is 0
    # wherever the output is NaN, so a reason layer's own footprint can't tell "not covered"
    # from "covered but blanked".)
    stack_in = np.zeros((1 + len(layers),) + nat.codes.shape)
    for i, (code, name) in enumerate(layers, start=1):
        m = nat.codes == code
        if name:
            m &= nat.names == name
        stack_in[i][m] = np.nan
    o, fp = reproject_interp((stack_in, wcs), grid, shape_out=shape)   # leading axis broadcasts
    inside = fp[0] > 0
    best = np.full(shape, 255, np.uint8)
    for i, (code, name) in enumerate(layers, start=1):   # categories are in priority order
        take = blank_out & inside & np.isnan(o[i]) & (table.rank_of[code] < best)
        res.codes[take], res.names[take] = code, name
        best[take] = table.rank_of[code]
    res.codes[blank_out & inside & (res.codes == VALID)] = table.code(UNEXPLAINED)
    res.codes[blank_out & ~inside] = table.code(NOT_OBSERVED)
    return res


def unknown(img: np.ndarray, table: Table) -> Reasons:
    """Reasons for a frame that came without any (e.g. a test fake): every blank -> unexplained."""
    r = Reasons.empty(img.shape)
    r.codes[~np.isfinite(img)] = table.code(UNEXPLAINED)
    return r


# ------------------------------------------------------------------------------- merge

def merge(a: Reasons | None, b: Reasons | None, table: Table) -> Reasons | None:
    """Pixelwise: the higher-priority code wins (0 = identity). Associative and commutative,
    so stacking, the live running state and refine deltas all fold with it."""
    if a is None:
        return b
    if b is None:
        return a
    take = table.rank_of[b.codes] < table.rank_of[a.codes]
    return Reasons(np.where(take, b.codes, a.codes).astype(np.uint8), np.where(take, b.names, a.names))


def fold(items, table: Table) -> Reasons | None:
    out = None
    for r in items:
        out = merge(out, r, table)
    return out


def stack(img: np.ndarray, per_exposure: list[Reasons | None], table: Table) -> Reasons:
    """Reasons for a stacked image. `per_exposure` = EVERY exposure that was loaded for this
    stack, including entirely blank ones that stack_epoch dropped (failed downloads = None).
    Valid stacked pixels -> 0; blank ones -> merged reason; blank with no exposure at all ->
    not_observed."""
    m = fold(per_exposure, table) or Reasons.empty(img.shape)
    blank = ~np.isfinite(img)
    codes = np.where(blank, m.codes, VALID).astype(np.uint8)
    codes[blank & (codes == VALID)] = table.code(NOT_OBSERVED)
    names = np.where(blank, m.names, "")
    return Reasons(codes, names)


# -------------------------------------------------------------------------------- JSON

def to_json(r: Reasons | None, table: Table, mask_valid: np.ndarray | None = None) -> dict:
    """Same orientation as export.to_jsonable (flipud, row 0 = top). {} if every code is 0.
      {'reasons': ['0003300...', ...],          one string per row, one digit per pixel
       'other_flags': {'PLANE': [[row, col], ...]}}   screen coords of other_flag pixels
                                                      (omitted if none)."""
    if r is None:
        return {}
    codes, names = r.codes, r.names
    if mask_valid is not None:
        codes = np.where(mask_valid, VALID, codes)
    if not codes.any():
        return {}
    flip, fnames = np.flipud(codes), np.flipud(names)
    out: dict = {"reasons": ["".join(map(str, row)) for row in flip.tolist()]}
    of = table.code(OTHER_FLAG)
    planes: dict[str, list[list[int]]] = {}
    for y, x in zip(*np.nonzero(flip == of)):
        planes.setdefault(str(fnames[y, x]), []).append([int(y), int(x)])
    if planes:
        out["other_flags"] = planes
    return out


def from_json(d: dict, size: int) -> Reasons:
    """Inverse of to_json (back to FITS orientation, row 0 = bottom)."""
    r = Reasons.empty((size, size))
    if not d.get("reasons"):
        return r
    flip = np.array([[int(ch) for ch in row] for row in d["reasons"]], np.uint8)
    names = np.full(flip.shape, "", dtype=object)
    for name, px in d.get("other_flags", {}).items():
        for y, x in px:
            names[y, x] = name
    return Reasons(np.flipud(flip), np.flipud(names))


def counts(r: Reasons, table: Table) -> dict[str, int]:
    """{key: n} of the non-valid codes (for logs / tests)."""
    keys = {c.code: c.key for c in table.categories}
    u, n = np.unique(r.codes[r.codes != VALID], return_counts=True)
    return {keys.get(int(k), str(k)): int(v) for k, v in zip(u, n)}
