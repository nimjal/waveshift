"""`just build [ids...]`: config -> pipeline -> web/public/data."""
from __future__ import annotations

from . import config, targets          # noqa: F401  (tests swap targets.resolve)
from .export import write_json         # noqa: F401
from .pipeline import build_target     # noqa: F401  (tests swap cli.build_target)


def build(only: list[str] | None = None) -> None:
    """For each config target (or only those ids): targets.resolve -> pipeline.build_target
    -> export.write_json(web_data_dir()/'targets'/'<id>.json').
    Call them as module attributes (targets.resolve, build_target) so they can be swapped in tests.
    One target failing prints ✗ and continues.
    Then write targets.json (list of {id, name, kind, file: 'targets/<id>.json', n_epochs},
    MERGED with any existing entries) and manifest.json {generated_at, collections, counts}."""
    raise NotImplementedError


def main() -> None:
    """argparse: `planetx build [ids ...]` -> build(ids or None)."""
    raise NotImplementedError


if __name__ == "__main__":
    main()
