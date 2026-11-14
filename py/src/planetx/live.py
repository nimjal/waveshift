"""Progressive refinement for live (custom RA/Dec) queries.

Stateless: the server never stores progress. The client carries an opaque cursor
"<plan digest>.<depth>.<stalls>" and keeps the running sums itself.

plan    = which exposures to use, in what order (one SIA query, no pixels).
          Cached under cache_dir()/plans purely to skip re-querying SIA; it is
          recomputed whenever missing, and its digest guards against drift.
slots   = one global sequence of detectors, e.g. D6 D5 D4 D3 D2 D1 D6 D5 ...
          Detector d appears min-over-epochs(#exposures of d) times, so at any depth
          every epoch has the same number of frames per detector (equal depth, same mix).
refine  = fetch slots [depth, depth+batch) for EVERY epoch, round-robin; commit only
          whole rounds (a slot done in every epoch), so all epochs stay equally deep.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path

import httpx
import numpy as np
from astropy.coordinates import SkyCoord

from . import config, cutouts, query, remote, stack, targets
from .export import write_json

log = logging.getLogger(__name__)

PLAN_VERSION = 1                              # bump when ordering rules change
DETECTOR_PRIORITY = ["D6", "D5", "D4", "D3", "D2", "D1"]  # long wavelength first: cold/red objects
PLAN_TTL_S = 6 * 3600
MAX_STALLS = 2                                # after this many no-progress calls, give up on the stuck round


class PlanMismatch(Exception):
    """The cursor was made for a different plan (archive changed). Client should restart."""


class BadCursor(ValueError):
    pass


# ---------------------------------------------------------------------------- plan

def _grid_params(sources: dict, images) -> tuple[int, float]:
    size_px = int(sources["grid"]["size_px"])
    scale = float(np.nanmedian(images["s_pixel_scale"])) if len(images) else float("nan")
    if not np.isfinite(scale):
        scale = float(sources["spherex"].get("pixel_scale_arcsec", 6.15))
    return size_px, round(scale, 4)


def _rank_key(row, center: SkyCoord) -> tuple[float, str]:
    """Best first: target closest to the image centre (full window coverage, least
    distortion, furthest from edge effects); obs_id breaks ties deterministically."""
    ra, dec = float(row["s_ra"]), float(row["s_dec"])
    if np.isfinite(ra) and np.isfinite(dec):
        d = float(center.separation(SkyCoord(ra, dec, unit="deg")).deg)
    else:
        d = 99.0
    return (round(d, 6), str(row["obs_id"]))


def build_plan(ra: float, dec: float, sources: dict) -> dict:
    """SIA query -> epochs + ordered exposure list per epoch. No pixels fetched."""
    sx = sources["spherex"]
    target = targets.adhoc(ra, dec)
    center = target.at(float(sx.get("obs_epoch", 2025.9)))
    images = query.find_images(center, sx["collections"])
    images = query.assign_epochs(images, float(sx.get("epoch_gap_days", 30)))
    size_px, scale = _grid_params(sources, images)

    summaries = query.epoch_summary(images) if len(images) else []
    ranked: list[dict[str, list]] = []
    for s in summaries:
        rows = images[images["epoch"] == s["index"]]
        per_det = {}
        for det in DETECTOR_PRIORITY:
            sel = [r for r in rows if r["detector"] == det]
            sel.sort(key=lambda r: _rank_key(r, center))
            per_det[det] = sel
        ranked.append(per_det)

    caps = {d: min((len(p[d]) for p in ranked), default=0) for d in DETECTOR_PRIORITY}
    slots: list[str] = []
    for r in range(max(caps.values(), default=0)):
        slots.extend(d for d in DETECTOR_PRIORITY if r < caps[d])

    epochs = []
    for s, per_det in zip(summaries, ranked):
        seen: dict[str, int] = {}
        exps = []
        for d in slots:
            row = per_det[d][seen.get(d, 0)]
            seen[d] = seen.get(d, 0) + 1
            exps.append({"obs_id": str(row["obs_id"]), "detector": d, "url": str(row["access_url"])})
        epochs.append({**{k: s[k] for k in ("id", "label", "mjd_start", "mjd_end", "year_mid", "n_images")},
                       "exposures": exps})

    sig = json.dumps([PLAN_VERSION, size_px, scale, sources.get("flags", {}).get("bad", []),
                      [[e["obs_id"] + e["detector"] for e in ep["exposures"]] for ep in epochs]])
    return {
        "digest": hashlib.sha1(sig.encode()).hexdigest()[:12],
        "created": time.time(),
        "ra": ra, "dec": dec,
        "center": [center.ra.deg, center.dec.deg],
        "size_px": size_px, "scale": scale,
        "collections": sorted(set(images["obs_collection"])) if len(images) else [],
        "detectors": query.detector_ranges(images) if len(images) else {},
        "n_images": int(len(images)),
        "slots": slots,
        "epochs": epochs,
    }


def _plan_path(ra: float, dec: float) -> Path:
    return config.cache_dir() / "plans" / f"plan_{ra:.4f}_{dec:+.4f}.json"


def get_plan(ra: float, dec: float, sources: dict, digest: str | None = None) -> dict:
    """Cached plan if fresh (and matching `digest` when given), else rebuild + cache."""
    path = _plan_path(ra, dec)
    try:
        plan = json.loads(path.read_text())
        if time.time() - plan["created"] < PLAN_TTL_S and (digest is None or plan["digest"] == digest):
            return plan
    except (OSError, ValueError, KeyError):
        pass
    plan = build_plan(ra, dec, sources)
    try:
        write_json(path, plan)
    except (OSError, ValueError) as e:
        log.warning("could not cache plan %s: %s", path, e)
    return plan


def plan_response(plan: dict, sources: dict, first_batch: int = 2) -> dict:
    """Public GET /target body: everything the client needs to draw and to start refining."""
    target = targets.adhoc(plan["ra"], plan["dec"])
    center = SkyCoord(*plan["center"], unit="deg")
    size_px, scale = plan["size_px"], plan["scale"]
    grid = stack.make_grid(center, size_px, scale)
    epochs = []
    for ep in plan["epochs"]:
        x, y = grid.world_to_pixel(target.at(ep["year_mid"]))
        epochs.append({k: ep[k] for k in ("id", "label", "mjd_start", "mjd_end", "year_mid", "n_images")}
                      | {"predicted_px": {"x": round(float(x), 3), "y": round(float(size_px - 1 - y), 3)},
                         "exposures": [{"obs_id": e["obs_id"], "detector": e["detector"]}
                                       for e in ep["exposures"]]})
    total = len(plan["slots"]) if epochs else 0
    return {
        "target": target.info(),
        "grid": {"size_px": size_px, "pixel_scale_arcsec": scale,
                 "center_ra": round(center.ra.deg, 6), "center_dec": round(center.dec.deg, 6),
                 "center_epoch": float(sources["spherex"].get("obs_epoch", 2025.9)),
                 "orientation": "north up, east left, row 0 = top"},
        "units": "MJy/sr (background-subtracted)",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "collections": plan["collections"],
        "detectors": plan["detectors"],
        "n_images": plan["n_images"],
        "epochs": epochs,
        "refine": {"cursor": make_cursor(plan["digest"], 0, 0), "total": total,
                   "slots": plan["slots"], "first_batch": first_batch, "done": total == 0},
    }


# -------------------------------------------------------------------------- cursor

def make_cursor(digest: str, depth: int, stalls: int) -> str:
    return f"{digest}.{depth}.{stalls}"


def parse_cursor(cursor: str) -> tuple[str, int, int]:
    try:
        digest, depth, stalls = cursor.split(".")
        depth, stalls = int(depth), int(stalls)
    except ValueError as e:
        raise BadCursor(f"malformed cursor {cursor!r}") from e
    if len(digest) != 12 or depth < 0 or stalls < 0:
        raise BadCursor(f"malformed cursor {cursor!r}")
    return digest, depth, stalls


# --------------------------------------------------------------------- one frame

TRANSIENT = (remote.Unavailable, remote.DeadlineExceeded, httpx.TransportError)


def _frame_path(url: str, plan: dict, bad: list[str]) -> Path:
    key = json.dumps([url, plan["center"], plan["size_px"], plan["scale"], bad, "v1"])
    return config.cache_dir() / "frames" / f"{hashlib.sha1(key.encode()).hexdigest()[:24]}.npy"


def _fetch_frame(client: httpx.Client, url: str, plan: dict, grid, bad: list[str],
                 margin: float, deadline: float) -> np.ndarray:
    """One exposure -> background-subtracted frame on the plan grid (NaN = no data).
    Disk-cached as a tiny .npy so a frame fetched after a call's deadline isn't wasted."""
    path = _frame_path(url, plan, bad)
    try:
        return np.load(path).astype(float)
    except (OSError, ValueError):
        pass
    center = SkyCoord(*plan["center"], unit="deg")
    size_px, scale = plan["size_px"], plan["scale"]
    half = int(np.ceil(size_px * margin / 2))
    try:
        # ZODI skipped: over a 2.5' window it is a near-constant that background
        # subtraction removes anyway (measured: < 3e-5 of frame rms), and it costs 2 round trips.
        data, wcs = remote.read_window(client, url, center, half, deadline, bad, subtract_zodi=False)
    except remote.UnsupportedLayout as e:
        log.info("range read unsupported (%s), using cutout service: %s", e, url)
        left = deadline - time.monotonic()
        if left <= 0.5:
            raise remote.DeadlineExceeded(url)
        size_deg = size_px * scale / 3600.0 * margin
        r = client.get(cutouts.cutout_url(url, center, size_deg), timeout=left)
        if r.status_code in (429, 503):
            raise remote.Unavailable(url)
        r.raise_for_status()
        data, wcs, _ = stack.load_cutout(io.BytesIO(r.content), bad)
    frame = stack.window_to_grid(data, wcs, grid, size_px)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part.npy")
        np.save(tmp, frame.astype(np.float32))
        tmp.replace(path)
    except OSError as e:
        log.warning("could not cache frame %s: %s", path, e)
    return frame


def _reason(e: BaseException) -> str:
    if isinstance(e, remote.NoCoverage):
        return "no_coverage"
    if isinstance(e, httpx.HTTPStatusError):
        return f"http_{e.response.status_code}"
    if isinstance(e, TRANSIENT):
        return "unavailable"
    if isinstance(e, (ValueError, OSError, remote.UnsupportedLayout)):
        return "bad_file"
    return "error"


# -------------------------------------------------------------------------- refine

def _flip_round(a: np.ndarray, sig: int = 5) -> list[list[float]]:
    return [[float(f"{v:.{sig}g}") for v in row] for row in np.flipud(a)]


def refine(ra: float, dec: float, cursor: str, batch_per_epoch: int, sources: dict,
           budget_s: float = 15.0, workers: int = 6) -> dict:
    """Advance every epoch by up to `batch_per_epoch` slots within ~budget_s.
    Returns per-epoch DELTAS for the committed slots: per detector a sum image and a
    per-pixel valid-count image (row 0 = top), plus failures with reason codes."""
    t0 = time.monotonic()
    deadline = t0 + budget_s
    digest, depth, stalls = parse_cursor(cursor)
    plan = get_plan(ra, dec, sources, digest)
    if plan["digest"] != digest:
        raise PlanMismatch(f"plan changed ({digest} -> {plan['digest']})")

    total = len(plan["slots"]) if plan["epochs"] else 0
    depth = min(depth, total)
    stop = min(total, depth + max(1, batch_per_epoch))
    center = SkyCoord(*plan["center"], unit="deg")
    grid = stack.make_grid(center, plan["size_px"], plan["scale"])
    bad = list(sources.get("flags", {}).get("bad", []))
    margin = float(sources["cutout"].get("margin", 1.5))
    n_ep = len(plan["epochs"])

    client = httpx.Client(follow_redirects=True, limits=httpx.Limits(max_connections=workers * 3))
    pool = ThreadPoolExecutor(max_workers=workers)
    futs = {}
    for s in range(depth, stop):                 # round-robin: slot s for every epoch, then s+1
        for e in range(n_ep):
            url = plan["epochs"][e]["exposures"][s]["url"]
            futs[(s, e)] = pool.submit(_fetch_frame, client, url, plan, grid, bad, margin, deadline)
    if futs:
        wait(futs.values(), timeout=max(0.0, deadline - time.monotonic()))

    def outcome(s: int, e: int, force: bool):
        """('ok', frame) | ('fail', reason) | None (not settled yet: retry next call)."""
        f = futs[(s, e)]
        if not f.done():
            return ("fail", "unavailable") if force else None
        exc = f.exception()
        if exc is None:
            return ("ok", f.result())
        if isinstance(exc, TRANSIENT) and not force:
            return None
        return ("fail", _reason(exc))

    committed: list[list[tuple]] = []
    for s in range(depth, stop):
        # Progress guarantee: after MAX_STALLS no-progress calls, settle the first round anyway.
        force = s == depth and stalls >= MAX_STALLS
        row = [outcome(s, e, force) for e in range(n_ep)]
        if any(o is None for o in row):
            break
        committed.append(row)

    # don't wait for stragglers; let them finish (and fill the frame cache) in the background
    pool.shutdown(wait=False, cancel_futures=True)
    pending = [f for f in futs.values() if not f.done()]
    if pending:
        threading.Thread(target=lambda: (wait(pending), client.close()), daemon=True).start()
    else:
        client.close()

    size = plan["size_px"]
    out_epochs = []
    for e, ep in enumerate(plan["epochs"]):
        sums: dict[str, np.ndarray] = {}
        counts: dict[str, np.ndarray] = {}
        used: dict[str, int] = {}
        failed = []
        for k, row in enumerate(committed):
            s = depth + k
            exp = ep["exposures"][s]
            det = exp["detector"]
            kind, val = row[e]
            sums.setdefault(det, np.zeros((size, size)))
            counts.setdefault(det, np.zeros((size, size), dtype=int))
            if kind == "ok":
                ok = np.isfinite(val)
                if ok.any():
                    sums[det][ok] += val[ok]
                    counts[det] += ok
                    used[det] = used.get(det, 0) + 1
                else:
                    failed.append({"slot": s, "obs_id": exp["obs_id"], "detector": det, "reason": "all_masked"})
            else:
                failed.append({"slot": s, "obs_id": exp["obs_id"], "detector": det, "reason": val})
        out_epochs.append({
            "id": ep["id"],
            "frames": {d: {"sum": _flip_round(sums[d]), "count": np.flipud(counts[d]).tolist(),
                           "n_images": used.get(d, 0)} for d in sums},
            "failed": failed,
        })

    new_depth = depth + len(committed)
    new_stalls = 0 if committed else stalls + 1
    return {
        "cursor": make_cursor(digest, new_depth, new_stalls),
        "depth": new_depth,
        "total": total,
        "done": new_depth >= total,
        "committed": len(committed),
        "elapsed_s": round(time.monotonic() - t0, 2),
        "epochs": out_epochs,
    }
