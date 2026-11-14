"""Light curve: the target's brightness per epoch and per detector, by fixed-aperture photometry
on the stacked frames of a built target (pipeline.build_target output / web target JSON, or the
live view's mean-stacked frames sent to POST /photometry).

Method, for each detector D1..D6 present in every epoch. `ALL` is NOT measured: it is a median
over every exposure of every detector, and each epoch has a different mix of detectors, so for a
red or blue star its "brightness" changes with the mix (RW Aur's ALL curve rises 3.7x while its D5
and D6 curves fall). Use one detector.

  Centre. ONE position for all epochs: the mean of the epochs' predicted positions (screen px).
    The aperture does not move from epoch to epoch and is not re-centred on the data, so the same
    pixels are summed in every epoch. For a stationary target (the variable stars) this is the
    predicted position. A moving target drifts across a fixed aperture; `track_px` (first -> last
    predicted position) is reported so the UI can say so.

  Pixel sets. A pixel belongs to a region when its CENTRE lies in it (no fractional pixels), so
    every epoch uses exactly the same pixel set.
    - aperture: distance from the centre <= R_AP (2.5 px; with integer centres this is a 21-pixel
      disc that fits in the 5 x 5 window motion.py uses);
    - background annulus: R_IN <= distance <= R_OUT (5 to 8 px), inside the grid.

  Saturated / blank core. Per epoch, the seeds are (a) the pixel nearest the centre if it is blank,
    and (b) every pixel inside the aperture whose reason code is 1 (saturated). The blank (null)
    pixels 4-connected to a seed form that epoch's blank core. (b) matters for a moving star: its
    saturated core can sit inside the aperture but off the centre pixel (Barnard's Star in D5),
    and must not be summed as if it were faint. Without reason codes (live views) only (a)
    applies; other blank aperture pixels are just excluded and counted (step 1 below). The
    UNION over all epochs is the core, so the measuring
    region is identical in every epoch (a core that grows in one epoch must not change what is
    summed). r_core = largest distance of a core pixel from the centre. If there is a core:
    - the aperture becomes a ring r_core + 1 <= distance <= r_core + 1 + GLOW_WIDTH (2 px), and
    - the background annulus moves out to ring_out + 1 <= distance <= ring_out + 1 + BG_WIDTH (3 px).
    This measures the star's outer glow, NOT its total flux (the core is missing); it is labelled
    "outer-glow brightness (core saturated)" when the frame's reason codes mark a core pixel as
    saturated (code 1), "outer-glow brightness (core flagged)" when they say it is blank for
    another reason, and "outer-glow brightness (core blank, likely saturated)" when reasons are
    unknown (live views). A core larger than R_CORE_MAX (9 px) is not measurable.

  Per epoch, with I = frame pixels in MJy/sr (already background-subtracted by the stacker):
    1. Exclusions: null pixels in the aperture (or ring) are left out and counted (n_excluded of
       n_aperture). No interpolation and no area correction, so a point with exclusions is biased
       low; points with n_excluded / n_aperture > EXCLUDED_WARN_FRAC (0.1) are marked
       `many_excluded` (drawn hollow). Null pixels in the annulus are also left out (n_bg used).
    2. Background b = median of the annulus' valid pixels; sigma = 1.4826 * MAD of the same pixels
       (robust per-pixel scatter). Needs >= MIN_BG (12) valid annulus pixels, else not measured.
    3. Flux F = sum over valid aperture pixels of (I - b), converted from MJy/sr x pixels to mJy
       with the pixel solid angle (pixel_scale_arcsec / 206264.806)^2 sr and 1 MJy = 1e9 mJy.
    4. Error from the annulus scatter only: sigma_F^2 = N * sigma^2 + N^2 * (pi/2) * sigma^2 / N_bg
       (N = valid aperture pixels; the second term is the error of a median background), in the
       same mJy units. The stacked frames carry no per-pixel variance, so the source's own photon
       noise is not included, and reprojection correlates neighbouring pixels, so this is a lower
       bound on the true error.

  Relative photometry (normalisation). Per frame key, a comparison star is taken in the SAME
    frame: candidates from motion.pick_reference_star (isolated local maxima >= 5 px from the
    target's track, >= 3 px from the edges, no null pixel in their 5 x 5 window in any epoch),
    brightest first; the first one whose plain-aperture flux (same R_AP, same annulus, its own
    centre) has S/N >= COMP_MIN_SNR (10) in every epoch is used. Then rel = F / F_comp, with errors
    added in quadrature (relative). This cancels changes common to both stars (e.g. a calibration
    offset between epochs) and assumes the comparison star is constant. When no star qualifies,
    `normalised` is false and only the raw flux is given; it must not be presented as relative.

Caveats (also in the UI): SPHEREx's linear variable filters mean each exposure in an epoch samples a given sky
position at a different wavelength within the detector's band, and the mix can differ between
epochs, so part of an epoch-to-epoch change in a red or blue source can be spectral, not temporal.
This is aperture photometry on 6.15"/px stacked images, an estimate, not calibrated photometry.
"""
from __future__ import annotations

import math

import numpy as np

from .motion import _image, pick_reference_star

R_AP = 2.5                # aperture radius (px)
R_IN, R_OUT = 5.0, 8.0    # background annulus (px)
GLOW_WIDTH = 2.0          # outer-glow ring width when the core is blank (px)
BG_WIDTH = 3.0            # background annulus width around the ring (px)
R_CORE_MAX = 9.0          # a larger blank core is not measured
MIN_BG = 12               # min valid annulus pixels
EXCLUDED_WARN_FRAC = 0.1  # > this fraction of aperture pixels excluded -> many_excluded (hollow point)
COMP_MIN_SNR = 10.0       # comparison star: min flux S/N in every epoch
FRAME_KEYS = ["D1", "D2", "D3", "D4", "D5", "D6"]   # not ALL (see above)
SATURATED = "1"           # reason code (docs/schema.md)

LABEL_APERTURE = "aperture flux"
LABEL_GLOW = {
    "saturated": "outer-glow brightness (core saturated)",
    "flagged": "outer-glow brightness (core flagged)",
    "unknown": "outer-glow brightness (core blank, likely saturated)",
}


def _dist(n: int, centre: tuple[float, float]) -> np.ndarray:
    yy, xx = np.mgrid[:n, :n]
    return np.hypot(xx - centre[0], yy - centre[1])


def _blank_core(img: np.ndarray, seeds: list[tuple[int, int]]) -> np.ndarray:
    """Null pixels 4-connected to any of the `seeds` (x, y); seeds on valid pixels are ignored."""
    n = img.shape[0]
    core = np.zeros(img.shape, dtype=bool)
    stack = []
    for x0, y0 in seeds:
        if 0 <= x0 < n and 0 <= y0 < n and not np.isfinite(img[y0, x0]) and not core[y0, x0]:
            core[y0, x0] = True
            stack.append((y0, x0))
    while stack:
        y, x = stack.pop()
        for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= yy < n and 0 <= xx < n and not core[yy, xx] and not np.isfinite(img[yy, xx]):
                core[yy, xx] = True
                stack.append((yy, xx))
    return core


def _core_kind(frames: list[dict], core: np.ndarray) -> str:
    """'saturated' if any epoch's reasons mark a core pixel as code 1, 'flagged' if reasons are
    known but none is, 'unknown' if no epoch has reasons (live views)."""
    known = False
    for f in frames:
        reasons = f.get("reasons")
        if not reasons:
            continue
        known = True
        ys, xs = np.nonzero(core)
        if any(reasons[y][x] == SATURATED for y, x in zip(ys, xs)):
            return "saturated"
    return "flagged" if known else "unknown"


def _phot(img: np.ndarray, ap: np.ndarray, ann: np.ndarray, sr_per_px: float) -> dict | None:
    """Flux (mJy) and error of one frame for the given aperture / annulus masks; None when the
    annulus has fewer than MIN_BG valid pixels or the aperture has none."""
    ok = np.isfinite(img)
    bgv = img[ann & ok]
    apv = img[ap & ok]
    n_ap = int(ap.sum())
    if bgv.size < MIN_BG or apv.size == 0:
        return None
    b = float(np.median(bgv))
    sigma = 1.4826 * float(np.median(np.abs(bgv - b)))
    k = 1e9 * sr_per_px                         # MJy/sr x px -> mJy
    flux = float((apv - b).sum()) * k
    n = apv.size
    err = math.sqrt(n * sigma ** 2 + n ** 2 * (math.pi / 2) * sigma ** 2 / bgv.size) * k
    return {"flux": flux, "flux_err": err, "n_aperture": n_ap, "n_excluded": n_ap - n, "n_bg": int(bgv.size)}


def _comparison(data: dict, key: str, imgs: list[np.ndarray], sr_per_px: float) -> tuple[dict, list[dict]] | None:
    """First (brightest) reference-star candidate measurable with S/N >= COMP_MIN_SNR and no
    excluded pixel in every epoch -> ({x, y, min_snr}, per-epoch phot), or None."""
    n = imgs[0].shape[0]
    for x, y in pick_reference_star(data, key):
        d = _dist(n, (x, y))
        ap, ann = d <= R_AP, (d >= R_IN) & (d <= R_OUT)
        res = [_phot(img, ap, ann, sr_per_px) for img in imgs]
        if any(r is None or r["n_excluded"] or r["flux_err"] <= 0 for r in res):
            continue
        snr = min(r["flux"] / r["flux_err"] for r in res)
        if snr >= COMP_MIN_SNR:
            return {"x": int(x), "y": int(y), "min_snr": round(snr, 1)}, res
    return None


def _r(v: float, sig: int = 4) -> float:
    return float(f"{v:.{sig}g}")


def measure_frame_key(data: dict, key: str) -> dict | None:
    """Light curve of the target in one frame key (see module docstring); None when the key is
    missing from some epoch."""
    eps = data.get("epochs", [])
    if not eps or not all(key in e["frames"] for e in eps):
        return None
    frames = [e["frames"][key] for e in eps]
    imgs = [_image(f) for f in frames]
    n = imgs[0].shape[0]
    scale = float(data["grid"]["pixel_scale_arcsec"])
    sr_per_px = (scale / 206264.806) ** 2
    cx = float(np.mean([e["predicted_px"]["x"] for e in eps]))
    cy = float(np.mean([e["predicted_px"]["y"] for e in eps]))
    d = _dist(n, (cx, cy))

    start = (int(round(cx)), int(round(cy)))
    in_ap = d <= R_AP
    core = np.zeros((n, n), dtype=bool)
    for img, f in zip(imgs, frames):
        seeds = [start]
        reasons = f.get("reasons")
        if reasons:   # saturated pixels anywhere in the aperture (a moving star's core)
            seeds += [(int(x), int(y)) for y, x in zip(*np.nonzero(in_ap)) if reasons[y][x] == SATURATED]
        core |= _blank_core(img, seeds)
    out: dict = {"mode": "aperture", "label": LABEL_APERTURE}
    if core.any():
        r_core = float(d[core].max())
        if r_core > R_CORE_MAX:
            return {"mode": "outer_glow", "label": LABEL_GLOW[_core_kind(frames, core)], "measurable": False,
                    "reason": "core_too_large", "r_core": round(r_core, 2), "points": [], "comparison": None,
                    "normalised": False}
        r0 = r_core + 1.0
        r1 = r0 + GLOW_WIDTH
        ap = (d >= r0) & (d <= r1) & ~core
        ann = (d >= r1 + 1.0) & (d <= r1 + 1.0 + BG_WIDTH)
        out = {"mode": "outer_glow", "label": LABEL_GLOW[_core_kind(frames, core)], "r_core": round(r_core, 2)}
        out["aperture_px"] = [round(r0, 2), round(r1, 2)]
        out["annulus_px"] = [round(r1 + 1.0, 2), round(r1 + 1.0 + BG_WIDTH, 2)]
    else:
        ap = d <= R_AP
        ann = (d >= R_IN) & (d <= R_OUT)
        out["aperture_px"] = [0.0, R_AP]
        out["annulus_px"] = [R_IN, R_OUT]

    res = [_phot(img, ap, ann, sr_per_px) for img in imgs]
    comp = _comparison(data, key, imgs, sr_per_px)
    points = []
    for e, r, k in zip(eps, res, range(len(eps))):
        p = {"epoch": e["id"], "mjd": round((e["mjd_start"] + e["mjd_end"]) / 2, 2)}
        if r is None:
            points.append({**p, "flux": None, "flux_err": None, "rel": None, "rel_err": None,
                           "n_aperture": int(ap.sum()), "n_excluded": None, "n_bg": None, "many_excluded": True})
            continue
        q = {**p, "flux": _r(r["flux"]), "flux_err": _r(r["flux_err"]), "rel": None, "rel_err": None,
             "n_aperture": r["n_aperture"], "n_excluded": r["n_excluded"], "n_bg": r["n_bg"],
             "many_excluded": r["n_excluded"] > EXCLUDED_WARN_FRAC * r["n_aperture"]}
        if comp:
            c = comp[1][k]
            rel = r["flux"] / c["flux"]
            rel_err = abs(rel) * math.hypot(r["flux_err"] / r["flux"] if r["flux"] else 0.0, c["flux_err"] / c["flux"])
            q["rel"], q["rel_err"] = _r(rel), _r(rel_err)
        points.append(q)
    return {**out, "measurable": any(p["flux"] is not None for p in points), "reason": None,
            "normalised": comp is not None, "comparison": comp[0] if comp else None, "points": points}


def measure_lightcurve(data: dict) -> dict | None:
    """Light curve of a built target dict for every frame key present in all epochs (see the
    module docstring for the exact method). None when there are no epochs. JSON-safe:
      {method, units, centre {x, y}, track_px, excluded_warn_frac, comp_min_snr,
       detectors: {key: {mode: 'aperture' | 'outer_glow', label, measurable, reason,
                         aperture_px [r0, r1], annulus_px [r0, r1], r_core?,
                         normalised, comparison {x, y, min_snr} | None,
                         points [{epoch, mjd, flux, flux_err, rel, rel_err,
                                  n_aperture, n_excluded, n_bg, many_excluded}]}}}"""
    eps = data.get("epochs", [])
    if not eps:
        return None
    p = [(e["predicted_px"]["x"], e["predicted_px"]["y"]) for e in eps]
    dets = {}
    for key in FRAME_KEYS:
        m = measure_frame_key(data, key)
        if m is not None:
            dets[key] = m
    return {
        "method": "fixed_aperture",
        "units": "mJy",
        "centre": {"x": round(float(np.mean([q[0] for q in p])), 3), "y": round(float(np.mean([q[1] for q in p])), 3)},
        "track_px": round(float(math.hypot(p[-1][0] - p[0][0], p[-1][1] - p[0][1])), 3),
        "excluded_warn_frac": EXCLUDED_WARN_FRAC,
        "comp_min_snr": COMP_MIN_SNR,
        "detectors": dets,
    }
