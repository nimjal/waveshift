"""Measured vs predicted motion of a curated target: a centroid estimate.

The measuring window must not depend on the prediction. A centroid is pulled toward the centre
of its window, so a window that follows the predicted track drags the "measured" shift toward the
predicted one (a stationary star would appear to move). Here the data decide where to measure:

Method, per detector, in this order: D6, D5, ... D1. The first detector where the target is
measurable in EVERY epoch is used. Cold movers (brown dwarfs) are brightest at long wavelengths,
and starting red avoids blue neighbours.
  1. Search region, the SAME in every epoch: a disc centred on the midpoint of the first and
     last epochs' predicted positions, radius = half the predicted track length + SEARCH_PAD
     (3 px). Only pixels inside the grid count.
  2. Background = median of the whole frame; noise = 1.4826 * MAD of the frame (robust sigma).
  3. Peak = the brightest valid (non-null) pixel inside the search region, after background
     subtraction. Peak S/N = (peak - background) / noise must be >= MIN_SNR, else 'faint'.
  4. Window = 5 x 5 pixels centred on THAT epoch's peak. Any null pixel in it ->
     'saturated' if its reason code is 1, else 'no_data' (also when the window leaves the grid).
  5. Centroid = intensity-weighted mean of the window's pixel centres, weights =
     max(pixel - background, 0).
  6. Same-object guard: if the peak jumps between consecutive epochs by more than that step's
     predicted motion + MAX_EXTRA_JUMP (2 px), the peaks are probably different objects ->
     'ambiguous' (not measurable) rather than a number.
  7. measured_px = distance between the first and last epoch's centroids;
     predicted_px = distance between the first and last epoch's predicted positions.

Null test (measure_at / null_test): the same measurement (_measure: search disc, peak, 5 x 5
centroid, guards) run on a stationary reference star, with predicted motion 0 (every predicted
position = the star's pixel). The star and its detector are picked automatically:
  - candidates per detector (pick_reference_star), on the epoch-mean frame of ALL, D1, D2, D3:
    isolated local maxima >= REF_MIN_DIST (5 px) from the target's predicted track, >= REF_EDGE
    (3 px) from the grid edges (the 5 x 5 window still fits), no null pixel in their 5 x 5 window
    in any epoch;
  - per detector, the brightest candidate that is measurable in EVERY epoch of that detector;
  - across detectors, the one with the highest S/N in its weakest epoch (S/N compares fairly
    between detectors; raw MJy/sr doesn't). It is measured in that detector.
A field with no such star (e.g. a bright target's glow or saturated wings everywhere) gets no
null test. Its measured shift shows the
method's noise floor and bias. It should be ~0.

Everything is in screen pixels of the stacked frames (6.15"/px), first vs last epoch. A centroid
on a 5 x 5 window is still pulled by neighbours and by an undersampled PSF: an estimate, not
astrometry.
"""
from __future__ import annotations

import numpy as np

DETECTOR_ORDER = ["D6", "D5", "D4", "D3", "D2", "D1"]
HALF = 2              # centroid window = (2*HALF+1)^2 = 5 x 5, centred on the epoch's peak
SEARCH_PAD = 3.0      # search radius = half the predicted track length + this (px)
MIN_SNR = 3.0         # on the peak
MAX_EXTRA_JUMP = 2.0  # peak jump allowed between consecutive epochs beyond the predicted step (px)
REF_MIN_DIST = 5.0    # reference star: min distance from the target's predicted track (px)
REF_EDGE = 3          # reference star: min distance from the grid edges (px); 5 x 5 window fits
REF_DETECTORS = ["ALL", "D1", "D2", "D3"]   # where reference stars are looked for
SATURATED = "1"       # reason code (docs/schema.md)
REASON_ORDER = ("saturated", "ambiguous", "faint", "no_data")   # most telling first


def _image(frame: dict) -> np.ndarray:
    """Frame pixels as a float array, null -> NaN (row 0 = top, as stored)."""
    return np.array([[np.nan if v is None else v for v in row] for row in frame["pixels"]], dtype=float)


def _stats(img: np.ndarray) -> tuple[float, float]:
    """(background, noise): median and 1.4826 * MAD of the frame's valid pixels."""
    bg = float(np.nanmedian(img))
    return bg, 1.4826 * float(np.nanmedian(np.abs(img - bg)))


def _region(n: int, centre: tuple[float, float], radius: float) -> np.ndarray:
    """Boolean (n, n) mask: grid pixels whose centre lies within `radius` of centre (x, y)."""
    yy, xx = np.mgrid[:n, :n]
    return np.hypot(xx - centre[0], yy - centre[1]) <= radius


def _measure_epoch(frame: dict, region: np.ndarray) -> dict:
    """One epoch: peak in `region`, then a 5x5 centroid around it.
    -> {'status': 'ok' | 'faint' | 'saturated' | 'no_data', 'peak': (x, y) | None,
        'centroid': (x, y) | None, 'snr': float}"""
    img = _image(frame)
    n = img.shape[0]
    bg, noise = _stats(img)
    cand = np.where(region & np.isfinite(img), img - bg, -np.inf)
    if not np.isfinite(cand).any():
        return {"status": "no_data", "peak": None, "centroid": None, "snr": 0.0}
    py, px = np.unravel_index(int(np.argmax(cand)), cand.shape)
    snr = float(cand[py, px]) / noise if noise > 0 else 0.0
    peak = (int(px), int(py))
    if snr < MIN_SNR:
        return {"status": "faint", "peak": peak, "centroid": None, "snr": snr}
    if py - HALF < 0 or px - HALF < 0 or py + HALF >= n or px + HALF >= n:
        return {"status": "no_data", "peak": peak, "centroid": None, "snr": snr}
    win = img[py - HALF:py + HALF + 1, px - HALF:px + HALF + 1]
    if np.isnan(win).any():
        reasons = frame.get("reasons")
        codes = "".join(reasons[r][px - HALF:px + HALF + 1] for r in range(py - HALF, py + HALF + 1)) if reasons else ""
        return {"status": "saturated" if SATURATED in codes else "no_data", "peak": peak, "centroid": None, "snr": snr}
    w = np.clip(win - bg, 0, None)
    yy, xx = np.mgrid[py - HALF:py + HALF + 1, px - HALF:px + HALF + 1]
    c = (float((w * xx).sum() / w.sum()), float((w * yy).sum() / w.sum()))
    return {"status": "ok", "peak": peak, "centroid": c, "snr": snr}


def _measure(epochs: list[dict], preds: list[tuple[float, float]], detectors: list[str]) -> dict:
    """Shared code path for the target and the null test. `preds` = predicted (x, y) per epoch
    (screen px). Returns the JSON-safe result (see measure_motion)."""
    (x0, y0), (x1, y1) = preds[0], preds[-1]
    track = float(np.hypot(x1 - x0, y1 - y0))
    centre = ((x0 + x1) / 2, (y0 + y1) / 2)
    radius = track / 2 + SEARCH_PAD
    out = {"predicted_px": round(track, 3), "window_px": 2 * HALF + 1, "min_snr": MIN_SNR,
           "search": {"x": round(centre[0], 3), "y": round(centre[1], 3), "radius_px": round(radius, 3)},
           "from_epoch": epochs[0]["id"], "to_epoch": epochs[-1]["id"]}
    why: set[str] = set()
    for det in detectors:
        if not all(det in e["frames"] for e in epochs):
            continue
        n = len(epochs[0]["frames"][det]["pixels"])
        region = _region(n, centre, radius)
        res = [_measure_epoch(e["frames"][det], region) for e in epochs]
        bad = {r["status"] for r in res if r["status"] != "ok"}
        if bad:
            why |= bad
            continue
        # same-object guard: consecutive peaks may only move by the predicted step + 2 px
        jumps_ok = all(
            np.hypot(b["peak"][0] - a["peak"][0], b["peak"][1] - a["peak"][1])
            <= np.hypot(pb[0] - pa[0], pb[1] - pa[1]) + MAX_EXTRA_JUMP
            for a, b, pa, pb in zip(res, res[1:], preds, preds[1:]))
        if not jumps_ok:
            why.add("ambiguous")
            continue
        (cx0, cy0), (cx1, cy1) = res[0]["centroid"], res[-1]["centroid"]
        return {**out, "measurable": True, "detector": det, "reason": None,
                "measured_px": round(float(np.hypot(cx1 - cx0, cy1 - cy0)), 3),
                "centroids": [{"epoch": e["id"], "x": round(r["centroid"][0], 3), "y": round(r["centroid"][1], 3),
                               "peak_x": r["peak"][0], "peak_y": r["peak"][1], "snr": round(r["snr"], 1)}
                              for e, r in zip(epochs, res)]}
    reason = next((r for r in REASON_ORDER if r in why), "no_data")
    return {**out, "measurable": False, "detector": None, "reason": reason,
            "measured_px": None, "centroids": []}


def measure_at(data: dict, x: float, y: float, detectors: list[str] | None = None) -> dict | None:
    """The same measurement for a STATIONARY source at screen pixel (x, y): every epoch's
    predicted position is (x, y), so predicted_px = 0. None when there are fewer than 2 epochs."""
    eps = data.get("epochs", [])
    if len(eps) < 2:
        return None
    return _measure(eps, [(float(x), float(y))] * len(eps), detectors or DETECTOR_ORDER)


def _dist_to_segment(px: np.ndarray, py: np.ndarray, a: tuple[float, float], b: tuple[float, float]) -> np.ndarray:
    """Distance from points (px, py) to the segment a-b (the target's predicted track)."""
    ax, ay = a
    dx, dy = b[0] - ax, b[1] - ay
    L2 = dx * dx + dy * dy
    t = np.clip(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1) if L2 > 0 else np.zeros_like(px, dtype=float)
    return np.hypot(px - (ax + t * dx), py - (ay + t * dy))


def pick_reference_star(data: dict, key: str) -> list[tuple[int, int]]:
    """Candidate isolated, unsaturated, presumably stationary stars in frames[key], as screen
    pixels (x, y), brightest first. On the epoch-mean frame: local maxima (>= all 8 neighbours) that are
      - >= REF_MIN_DIST px from the target's predicted track and >= REF_EDGE px from the grid edges,
      - free of null pixels in their 5 x 5 window in EVERY epoch (unsaturated, covered),
      - isolated: no other local maximum within 3 px brighter than 30% of this one."""
    eps = data.get("epochs", [])
    if len(eps) < 2 or not all(key in e["frames"] for e in eps):
        return []
    import warnings

    stack = np.stack([_image(e["frames"][key]) for e in eps])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)   # pixels null in every epoch stay NaN
        mean = np.nanmean(stack, axis=0)
    n = mean.shape[0]
    bg, _ = _stats(mean)
    sig = np.nan_to_num(mean - bg, nan=-np.inf)
    pad = np.pad(sig, 1, constant_values=-np.inf)
    neigh = np.max([pad[1 + dy:1 + dy + n, 1 + dx:1 + dx + n]
                    for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx], axis=0)
    yy, xx = np.mgrid[:n, :n]
    p = [(e["predicted_px"]["x"], e["predicted_px"]["y"]) for e in eps]
    far = _dist_to_segment(xx, yy, p[0], p[-1]) >= REF_MIN_DIST
    inside = (xx >= REF_EDGE) & (yy >= REF_EDGE) & (xx <= n - 1 - REF_EDGE) & (yy <= n - 1 - REF_EDGE)
    is_max = np.isfinite(sig) & (sig > 0) & (sig >= neigh)
    cands = [(float(sig[y, x]), int(x), int(y)) for y, x in zip(*np.nonzero(is_max & far & inside))]
    maxima = [(float(sig[y, x]), int(x), int(y)) for y, x in zip(*np.nonzero(is_max))]
    out = []
    for s, x, y in sorted(cands, reverse=True):
        if np.isnan(stack[:, y - HALF:y + HALF + 1, x - HALF:x + HALF + 1]).any():
            continue
        if any(0 < np.hypot(x2 - x, y2 - y) <= 3 and s2 > 0.3 * s for s2, x2, y2 in maxima):
            continue
        out.append((x, y))
    return out


def null_test(data: dict) -> dict | None:
    """The target's measurement on a stationary reference star (predicted motion 0), in the
    detector where that star is brightest and measurable in every epoch (see module docstring).
    -> {x, y, measured_px, detector, measurable, min_snr, reason} or None if no star qualifies."""
    best = None
    for key in REF_DETECTORS:
        for x, y in pick_reference_star(data, key):          # brightest first
            m = measure_at(data, x, y, detectors=[key])
            if m is not None and m["measurable"]:
                snr = min(c["snr"] for c in m["centroids"])  # weakest epoch
                if best is None or snr > best[0]:
                    best = (snr, key, x, y, m)
                break                                          # this detector's brightest measurable
    if best is None:
        return None
    snr, key, x, y, m = best
    return {"x": x, "y": y, "measured_px": m["measured_px"], "detector": key,
            "measurable": True, "min_snr": round(snr, 1), "reason": None}


def measure_motion(data: dict) -> dict | None:
    """Centroid estimate of the target's shift between the first and last epoch, from a
    built target dict (pipeline.build_target output / web target JSON). None when there
    are fewer than 2 epochs. Otherwise a JSON-safe dict:
      measurable, measured_px (or None), predicted_px, detector (or None), window_px, min_snr,
      search {x, y, radius_px}, from_epoch, to_epoch,
      reason (None | 'saturated' | 'ambiguous' | 'faint' | 'no_data'),
      centroids: [{epoch, x, y, peak_x, peak_y, snr}] for the chosen detector,
      null_test: {x, y, measured_px, detector, measurable, reason} | None (reference star)."""
    eps = data.get("epochs", [])
    if len(eps) < 2:
        return None
    preds = [(e["predicted_px"]["x"], e["predicted_px"]["y"]) for e in eps]
    m = _measure(eps, preds, DETECTOR_ORDER)
    m["null_test"] = null_test(data)
    return m
