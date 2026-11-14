from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone

from . import config, targets          # tests swap targets.resolve
from .export import write_json
from .pipeline import build_target     # tests swap cli.build_target


def _progress(done: int, total: int) -> None:
    if done == total or done % 10 == 0:
        print(f"    cutouts {done}/{total}", flush=True)


def build(only: list[str] | None = None) -> None:
    """For each config target (or only those ids): targets.resolve -> pipeline.build_target
    -> export.write_json(web_data_dir()/'targets'/'<id>.json').
    Call them as module attributes (targets.resolve, build_target) so they can be swapped in tests.
    One target failing prints ✗ and continues.
    Then write targets.json (list of {id, name, kind, file: 'targets/<id>.json', n_epochs},
    MERGED with any existing entries, ordered as in targets.toml, unknown ids last) and
    manifest.json {generated_at, collections, counts} (counts also MERGED, so building one
    target doesn't drop the others)."""

    sources = config.load_sources()
    out = config.web_data_dir()
    index_path, manifest_path = out / "targets.json", out / "manifest.json"
    index = {e["id"]: e for e in (json.loads(index_path.read_text()) if index_path.exists() else [])}
    counts = json.loads(manifest_path.read_text()).get("counts", {}) if manifest_path.exists() else {}
    cfgs = config.load_targets()

    for cfg in cfgs:
        if only and cfg["id"] not in only:
            continue
        print(f"▶ {cfg['id']} — {cfg['name']}", flush=True)
        try:
            t = targets.resolve(cfg)
            data = build_target(t, sources, config.cache_dir(), progress=_progress, spectrum=True)
        except Exception as e:  # noqa: BLE001 — one bad target shouldn't stop the rest
            print(f"  ✗ {cfg['id']}: {type(e).__name__}: {e}", flush=True)
            continue
        spec = data.pop("spectrum", None)
        if spec is not None:   # lazily loaded by the web app on the first spectrum click
            write_json(out / "targets" / f"{t.id}.spectrum.json", spec)
        write_json(out / "targets" / f"{t.id}.json", data)
        index[t.id] = {"id": t.id, "name": t.name, "kind": t.kind, "file": f"targets/{t.id}.json",
                       "n_epochs": len(data["epochs"])}
        counts[t.id] = {"images": data["n_images"], "used": data.get("n_used", 0),
                        "epochs": len(data["epochs"])}
        print(f"  ✓ {len(data['epochs'])} epochs, {data['n_images']} images", flush=True)
    
    rank = {c["id"]: n for n, c in enumerate(cfgs)}
    write_json(index_path, sorted(index.values(), key=lambda e: rank.get(e["id"], len(rank))))
    write_json(manifest_path, {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "collections": sources["spherex"]["collections"],
        "counts": counts,
    })


def annotate(only: list[str] | None = None) -> None:
    """Recompute derived fields of already-built target files without touching the archive:
    `motion` (motion.measure_motion) for every target with a known proper motion."""
    from . import motion

    out = config.web_data_dir() / "targets"
    for cfg in config.load_targets():
        if only and cfg["id"] not in only:
            continue
        path = out / f"{cfg['id']}.json"
        if not path.exists():
            print(f"  - {cfg['id']}: not built", flush=True)
            continue
        data = json.loads(path.read_text())
        t = data.get("target", {})
        m = motion.measure_motion(data) if (t.get("pmra") or t.get("pmdec")) else None
        data.pop("motion", None)
        if m is not None:
            data["motion"] = m
        write_json(path, data)
        desc = ("no motion" if m is None else
                f"{m['measured_px']:.2f} px vs {m['predicted_px']:.2f} predicted ({m['detector']})"
                if m["measurable"] else f"not measurable ({m['reason']})")
        print(f"  ✓ {cfg['id']}: {desc}", flush=True)


def main() -> None:
    """argparse: `planetx build [ids ...]` -> build(ids or None)."""
    logging.basicConfig(level=logging.WARNING, format="  %(levelname)s %(message)s")
    p = argparse.ArgumentParser(prog="planetx")
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="build curated targets into web/public/data")
    b.add_argument("ids", nargs="*", help="only these target ids")
    a = sub.add_parser("annotate", help="recompute derived fields (motion) of built target files")
    a.add_argument("ids", nargs="*", help="only these target ids")
    args = p.parse_args()
    if args.cmd == "build":
        build(args.ids or None)
    elif args.cmd == "annotate":
        annotate(args.ids or None)


if __name__ == "__main__":
    main()
