"""One function the CLI and the API both call: Target -> per-target JSON dict."""
from __future__ import annotations

from pathlib import Path

from . import cutouts, query, stack    # noqa: F401  (call as module.func so tests can swap them)
from .export import to_jsonable        # noqa: F401
from .targets import Target


def build_target(target: Target, sources: dict, cache: Path,
                 max_per_group: int | None = None,
                 detectors: list[str] | None = None,
                 progress=None) -> dict:
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
                frames: {DET: {n_images, pixels (export.to_jsonable), flagged_fraction}}}]
    No images -> same keys with epochs = [], detectors = {}, n_images = 0."""
    raise NotImplementedError
