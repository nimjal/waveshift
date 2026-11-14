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
    MERGED with any existing entries) and manifest.json {generated_at, collections, counts}."""

    sources = config.load_sources()
    out = config.web_data_dir()
    index_path, manifest_path = out / "targets.json", out / "manifest.json"
    index = {e["id"]: e for e in (json.loads(index_path.read_text()) if index_path.exists() else [])}
    counts = {}

    for cfg in config.load_targets():
        if only and cfg["id"] not in only:
            continue
        print(f"▶ {cfg['id']} — {cfg['name']}", flush=True)
        try:
            t = targets.resolve(cfg)
            data = build_target(t, sources, config.cache_dir(), progress=_progress)
        except Exception as e:  # noqa: BLE001 — one bad target shouldn't stop the rest
            print(f"  ✗ {cfg['id']}: {type(e).__name__}: {e}", flush=True)
            continue
        write_json(out / "targets" / f"{t.id}.json", data)
        index[t.id] = {"id": t.id, "name": t.name, "kind": t.kind, "file": f"targets/{t.id}.json",
                       "n_epochs": len(data["epochs"])}
        counts[t.id] = {"images": data["n_images"], "used": data.get("n_used", 0),
                        "epochs": len(data["epochs"])}
        print(f"  ✓ {len(data['epochs'])} epochs, {data['n_images']} images", flush=True)
    
    write_json(index_path, list(index.values()))
    write_json(manifest_path, {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "collections": sources["spherex"]["collections"],
        "counts": counts,
    })


def main() -> None:
    """argparse: `planetx build [ids ...]` -> build(ids or None)."""
    logging.basicConfig(level=logging.WARNING, format="  %(levelname)s %(message)s")
    p = argparse.ArgumentParser(prog="planetx")
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="build curated targets into web/public/data")
    b.add_argument("ids", nargs="*", help="only these target ids")
    args = p.parse_args()
    if args.cmd == "build":
        build(args.ids or None)


if __name__ == "__main__":
    main()
