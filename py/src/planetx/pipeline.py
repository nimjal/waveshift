from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import cutouts, motion, photometry, query, spectral, stack    # call as module.func so tests can swap them
from .export import reasons_jsonable, to_jsonable
from .targets import Target

log = logging.getLogger(__name__)


def _subsample(idx: np.ndarray, n: int | None) -> np.ndarray:
    """Evenly spaced subset so a cap still spans the whole epoch."""
    if n is None or len(idx) <= n:
        return idx
    return idx[np.linspace(0, len(idx) - 1, n).round().astype(int)]


def build_target(target: Target, sources: dict, cache: Path,
                 max_per_group: int | None = None,
                 detectors: list[str] | None = None,
                 progress=None, spectrum: bool = False) -> dict:
    """Full chain for one target. Steps:
    1. center = target.at(sources['spherex']['obs_epoch'])
    2. images = query.find_images(center, collections); filter `detectors` if given;
       query.assign_epochs(images, epoch_gap_days)
    3. scale = median s_pixel_scale (fallback sources['spherex']['pixel_scale_arcsec'])
       grid = stack.make_grid(center, size_px, scale)
    4. per (epoch, detector) choose rows — if max_per_group, an EVENLY SPACED subset
    5. size_deg = size_px * scale / 3600 * sources['cutout']['margin'];
       paths = cutouts.fetch_many(urls, cache, workers, progress)   (call via `cutouts.`)
    6. every path -> stack.to_grid(..., bad_flags=sources['flags']['bad']); failures -> None
    7. per epoch: per detector stack_epoch -> frames['D1'..]; plus frames['ALL'] =
       stack of every frame in that epoch. Omit detectors with nothing usable.
    8. predicted_px per epoch = grid.world_to_pixel(target.at(year_mid)),
       converted to SCREEN coords: x same, y = size_px - 1 - y
    Return (no NaN anywhere — must pass json.dumps(allow_nan=False)):
      target: target.info()
      grid: {size_px, pixel_scale_arcsec, center_ra, center_dec, center_epoch, orientation}
      units, generated_at (UTC ISO), collections, detectors (query.detector_ranges),
      n_images, n_used,
      epochs: [{id, label, mjd_start, mjd_end, year_mid, n_images, predicted_px: {x, y},
                frames: {DET: {n_images, pixels (export.to_jsonable), flagged_fraction,
                               [reasons, flags] (export.reasons_jsonable)}}}]
    Step 6 uses stack.to_grid_reasons (saturation planes = sources['flags']['saturated'])
    and step 7 stack.stack_reasons, so every frame says why its blank pixels are blank.
    No images -> same keys with epochs = [], detectors = {}, n_images = 0.
    spectrum=True adds key 'spectrum' = the per-exposure samples (spectrum_sidecar) that the
    CLI writes to a separate file; targets with a known proper motion also get 'motion'."""
    
    sx = sources["spherex"]
    size_px = int(sources["grid"]["size_px"])
    center = target.at(float(sx.get("obs_epoch", 2025.9)))

    images = query.find_images(center, sx["collections"])
    if detectors:
        images = images[np.isin(images["detector"], detectors)]
    images = query.assign_epochs(images, float(sx.get("epoch_gap_days", 30)))

    scale = float(np.nanmedian(images["s_pixel_scale"])) if len(images) else float("nan")
    if not np.isfinite(scale):
        scale = float(sx.get("pixel_scale_arcsec", 6.15))
    grid = stack.make_grid(center, size_px, scale)

    base = {
        "target": target.info(),
        "grid": {"size_px": size_px, "pixel_scale_arcsec": round(scale, 4),
                 "center_ra": round(center.ra.deg, 6), "center_dec": round(center.dec.deg, 6),
                 "center_epoch": float(sx.get("obs_epoch", 2025.9)),
                 "orientation": "north up, east left, row 0 = top"},
        "units": "MJy/sr (background-subtracted)",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "collections": sorted(set(images["obs_collection"])) if len(images) else [],
    }
    if len(images) == 0:
        return {**base, "detectors": {}, "epochs": [], "n_images": 0, "n_used": 0}

    # choose rows (optionally capped per epoch x detector), fetch in parallel
    chosen = []
    for ep in np.unique(images["epoch"]):
        for det in np.unique(images["detector"]):
            idx = np.where((images["epoch"] == ep) & (images["detector"] == det))[0]
            chosen.extend(_subsample(idx, max_per_group).tolist())
    chosen = sorted(chosen)
    size_deg = size_px * scale / 3600.0 * float(sources["cutout"].get("margin", 1.5))
    urls = [cutouts.cutout_url(images["access_url"][i], center, size_deg) for i in chosen]
    paths = cutouts.fetch_many(urls, cache, int(sources["cutout"].get("workers", 4)), progress)

    flag_cfg = sources.get("flags", {})
    bad = list(flag_cfg.get("bad", []))
    sat = list(flag_cfg.get("saturated", []))
    frames: dict[int, np.ndarray | None] = {}
    blanks: dict[int, stack.Blank | None] = {}
    waves: dict[int, dict | None] = {}
    for i, p in zip(chosen, paths):
        try:
            frames[i], blanks[i] = stack.to_grid_reasons(p, grid, size_px, bad, sat) if p else (None, None)
        except Exception as e:  # noqa: BLE001
            log.warning("reproject failed for %s: %s", images["obs_id"][i], e)
            frames[i], blanks[i] = None, None
        if spectrum and frames[i] is not None:
            try:
                waves[i] = spectral.exposure_wavelength(p, grid, size_px)
            except Exception as e:  # noqa: BLE001
                log.warning("no wavelength for %s: %s", images["obs_id"][i], e)

    def frame_out(arrs, bls):
        img, n = stack.stack_epoch(arrs)
        if img is None:
            return None
        why = stack.stack_reasons(img, arrs, bls)
        return {"n_images": n, "pixels": to_jsonable(img),
                "flagged_fraction": round(float(np.isnan(img).mean()), 4),
                **(reasons_jsonable(why.codes, why.names) if why else {})}

    epochs_out = []
    for summ in query.epoch_summary(images):
        ep = summ["index"]
        ep_frames, all_arrs, all_bls = {}, [], []
        for det in sorted(set(images["detector"])):
            idx = [i for i in chosen if images["epoch"][i] == ep and images["detector"][i] == det]
            arrs, bls = [frames[i] for i in idx], [blanks[i] for i in idx]
            f = frame_out(arrs, bls)
            if f is None:
                continue
            all_arrs.extend(arrs)
            all_bls.extend(bls)
            ep_frames[det] = f
        f = frame_out(all_arrs, all_bls)
        if f is not None:
            ep_frames["ALL"] = f
        # where the target SHOULD be this epoch, in screen pixels (row 0 = top)
        x, y = grid.world_to_pixel(target.at(summ["year_mid"]))
        track = {"x": round(float(x), 3), "y": round(float(size_px - 1 - y), 3)}
        epochs_out.append({k: summ[k] for k in
                           ("id", "label", "mjd_start", "mjd_end", "year_mid", "n_images")}
                          | {"predicted_px": track, "frames": ep_frames})

    out = {**base, "detectors": query.detector_ranges(images),
           "epochs": epochs_out, "n_images": int(len(images)),
           "n_used": int(sum(f is not None for f in frames.values()))}
    if target.pmra or target.pmdec:   # known proper motion: measured vs predicted shift
        m = motion.measure_motion(out)
        if m is not None:
            out["motion"] = m
    lc = photometry.measure_lightcurve(out)   # brightness per epoch per detector
    if lc is not None:
        out["lightcurve"] = lc
    if spectrum:
        ep_id = {s["index"]: s["id"] for s in query.epoch_summary(images)}
        out["spectrum"] = spectrum_sidecar(
            target, size_px, out["units"],
            [(ep_id[int(images["epoch"][i])], str(images["detector"][i]), str(images["obs_id"][i]),
              frames[i], blanks[i], waves.get(i)) for i in chosen])
    return out


def spectrum_sidecar(target: Target, size_px: int, units: str, samples: list[tuple]) -> dict:
    """Per-exposure frames for the on-the-fly spectrum (web: targets/<id>.spectrum.json).
    samples: (epoch id, detector, obs_id, frame on the grid | None, Blank | None, wave | None).
    Exposures without a frame or a wavelength are skipped. Wavelength at screen pixel
    (col, row) = wave[0] + wave[1]*(col - c) + wave[2]*(row - c), c = (size_px - 1) / 2
    (spectral.grid_wavelength). pixels/reasons use the same orientation and codes as the
    stacked frames (row 0 = top; null = blank, reasons say why)."""
    exps = []
    for ep, det, oid, frame, blank, wave in samples:
        if frame is None or wave is None or not np.isfinite(frame).any():
            continue
        why = reasons_jsonable(blank.codes, blank.names) if blank is not None else {}
        exps.append({"epoch": ep, "detector": det, "obs_id": oid, "wave": wave["wave"],
                     "bandwidth": wave["bandwidth"], "pixels": to_jsonable(frame, sig=4),
                     **({"reasons": why["reasons"]} if "reasons" in why else {})})
    return {"target": target.id, "size_px": size_px, "units": units, "wave_unit": "um",
            "wave_origin_px": (size_px - 1) / 2, "exposures": exps}
