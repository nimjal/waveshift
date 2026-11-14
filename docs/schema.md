# Data contract (pipeline → web)

The live API (`GET /target?ra=&dec=`) returns the SAME per-target shape.

## web/public/data/targets.json
[{ id, name, kind, file, n_epochs }]

## web/public/data/targets/<id>.json
target:   { id, name, kind, ra, dec, pmra, pmdec, ref_epoch }   # mas/yr; position at ref_epoch
grid:     { size_px, pixel_scale_arcsec, center_ra, center_dec, center_epoch,
            orientation: "north up, east left, row 0 = top" }
units:    "MJy/sr (background-subtracted)"
generated_at, collections[], n_images, n_used
detectors: { D1: [lo_um, hi_um], ... }
epochs: [{
  id: "A", label: "May 2025", mjd_start, mjd_end, year_mid, n_images,
  predicted_px: { x, y },            # where the target should be, screen pixels
  frames: {
    D1..D6: { n_images, pixels: [[...]], flagged_fraction },
    ALL:    { ... }                  # median over every detector = default view
  }
}]

## web/public/data/manifest.json
{ generated_at, collections[], counts: { <id>: { images, used, epochs } } }

## Rules
- pixels: row 0 = top (rows already flipped from FITS). null = no data.
- Never NaN (writer uses allow_nan=False).
- A detector with no usable data is omitted, not empty.
- Moving east = moving LEFT on screen.
