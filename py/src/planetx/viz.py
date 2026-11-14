from __future__ import annotations

import json
from pathlib import Path

import numpy as np


def show_epochs(path_or_data, detector: str = "ALL"):
    import matplotlib.pyplot as plt

    d = json.loads(Path(path_or_data).read_text()) if isinstance(path_or_data, (str, Path)) \
        else path_or_data
    eps = [e for e in d["epochs"] if detector in e["frames"]]
    if not eps:
        print(f"no '{detector}' frames")
        return
    fig, axes = plt.subplots(1, len(eps), figsize=(4 * len(eps), 4), squeeze=False)
    for ax, e in zip(axes[0], eps):
        img = np.array(e["frames"][detector]["pixels"], dtype=float)  # None -> nan
        ax.imshow(img, origin="upper", cmap="gray",
                  vmin=np.nanpercentile(img, 5), vmax=np.nanpercentile(img, 99.5),
                  interpolation="nearest")
        p = e["predicted_px"]
        ax.plot(p["x"], p["y"], "r+", ms=14, mew=1.5)
        ax.set_title(f"{e['id']} · {e['label']} · {detector} · n={e['frames'][detector]['n_images']}")
        ax.set_xticks([]); ax.set_yticks([])
    fig.suptitle(d["target"]["name"])
    plt.show()
