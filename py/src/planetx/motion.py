"""Measured vs predicted motion of a curated target: a centroid estimate.

Method (reconstructs the WISE 0855 notebook check, which gave ~1.45 px measured vs ~1.32 px
predicted):
  1. Detector: the LONGEST-wavelength detector (D6 first, then D5, ... D1) in which the target
     is measurable in EVERY epoch. Cold movers (brown dwarfs) are brightest there, and it
     avoids blue neighbours: WISE 0855 is invisible below ~3 um, so its D1/D2 frames (and the
     ALL stack) are pulled toward a nearby star (ALL gives 1.13 px).
  2. Window: 3 x 3 pixels centred on the epoch's predicted position (rounded to a pixel).
  3. Measurable in an epoch = all 9 window pixels have data (a saturated or flagged pixel is
     null in the stacked frame), and peak S/N >= MIN_SNR, where
       background = median of the whole 25 x 25 frame,
       noise      = 1.4826 * MAD of the frame (robust sigma),
       peak S/N   = (max of window - background) / noise.
  4. Centroid = intensity-weighted mean of pixel centres in the window, weights =
     max(pixel - background, 0).
  5. measured_px  = distance between the first and last epoch's centroids;
     predicted_px = distance between the first and last epoch's predicted positions.
Everything is in screen pixels of the stacked frames (6.15"/px). A 3 x 3 centroid is biased
toward the window centre and sensitive to neighbours: an estimate, not astrometry.
"""
from __future__ import annotations

import numpy as np

DETECTOR_ORDER = ["D6", "D5", "D4", "D3", "D2", "D1"]
HALF = 1            # window = (2*HALF+1)^2 = 3 x 3
MIN_SNR = 3.0       # WISE 0855's weakest D6 epoch is ~4.3
SATURATED = "1"     # reason code (docs/schema.md)


def _window(frame: dict, cx: int, cy: int) -> tuple[np.ndarray, list[str]] | None:
    """3x3 pixel values (NaN = null) and their reason codes, or None if off the grid."""
    px = frame["pixels"]
    n = len(px)
    if cy - HALF < 0 or cx - HALF < 0 or cy + HALF >= n or cx + HALF >= n:
        return None
    rows = range(cy - HALF, cy + HALF + 1)
    vals = np.array([[np.nan if px[r][c] is None else px[r][c] for c in range(cx - HALF, cx + HALF + 1)]
                     for r in rows], dtype=float)
    reasons = frame.get("reasons")
    codes = [reasons[r][cx - HALF:cx + HALF + 1] if reasons else "" for r in rows]
    return vals, codes


def _measure_epoch(frame: dict, pred: dict) -> tuple[str, tuple[float, float] | None, float]:
    """('ok', (x, y), snr) | ('saturated' | 'no_data' | 'faint', None, snr) for one frame."""
    cx, cy = int(round(pred["x"])), int(round(pred["y"]))
    win = _window(frame, cx, cy)
    if win is None:
        return "no_data", None, 0.0
    vals, codes = win
    if np.isnan(vals).any():
        return ("saturated" if any(SATURATED in row for row in codes) else "no_data"), None, 0.0
    img = np.array([[np.nan if v is None else v for v in row] for row in frame["pixels"]], dtype=float)
    bg = float(np.nanmedian(img))
    noise = 1.4826 * float(np.nanmedian(np.abs(img - bg)))
    snr = (float(vals.max()) - bg) / noise if noise > 0 else 0.0
    if snr < MIN_SNR:
        return "faint", None, snr
    w = np.clip(vals - bg, 0, None)
    yy, xx = np.mgrid[cy - HALF:cy + HALF + 1, cx - HALF:cx + HALF + 1]
    return "ok", (float((w * xx).sum() / w.sum()), float((w * yy).sum() / w.sum())), snr


def measure_motion(data: dict) -> dict | None:
    """Centroid estimate of the target's shift between the first and last epoch, from a
    built target dict (pipeline.build_target output / web target JSON). None when there
    are fewer than 2 epochs. Otherwise a JSON-safe dict:
      measurable, measured_px (or None), predicted_px, detector (or None), window_px, min_snr,
      from_epoch, to_epoch, reason (None | 'saturated' | 'faint' | 'no_data'),
      centroids: [{epoch, x, y, snr}] for the chosen detector."""
    eps = data.get("epochs", [])
    if len(eps) < 2:
        return None
    p0, p1 = eps[0]["predicted_px"], eps[-1]["predicted_px"]
    out = {"predicted_px": round(float(np.hypot(p1["x"] - p0["x"], p1["y"] - p0["y"])), 3),
           "window_px": 2 * HALF + 1, "min_snr": MIN_SNR,
           "from_epoch": eps[0]["id"], "to_epoch": eps[-1]["id"]}
    why: set[str] = set()
    for det in DETECTOR_ORDER:
        if not all(det in e["frames"] for e in eps):
            continue
        res = [_measure_epoch(e["frames"][det], e["predicted_px"]) for e in eps]
        bad = {r[0] for r in res if r[0] != "ok"}
        if bad:
            why |= bad
            continue
        (x0, y0), (x1, y1) = res[0][1], res[-1][1]
        return {**out, "measurable": True, "detector": det, "reason": None,
                "measured_px": round(float(np.hypot(x1 - x0, y1 - y0)), 3),
                "centroids": [{"epoch": e["id"], "x": round(r[1][0], 3), "y": round(r[1][1], 3),
                               "snr": round(r[2], 1)} for e, r in zip(eps, res)]}
    # nothing measurable: report the most telling reason
    reason = next((r for r in ("saturated", "faint", "no_data") if r in why), "no_data")
    return {**out, "measurable": False, "detector": None, "reason": reason,
            "measured_px": None, "centroids": []}
