// Types for the pipeline → web data contract (docs/schema.md).
// The live API (GET /target) returns the same TargetData shape as the curated files.

/** One entry of web/public/data/targets.json */
export interface TargetIndexEntry {
  id: string
  name: string
  kind: string
  /** path relative to the data/ directory, e.g. "targets/barnard.json" */
  file: string
  n_epochs: number
}

export interface TargetInfo {
  id: string
  name: string
  kind: string
  ra: number
  dec: number
  /** mas/yr, already multiplied by cos(dec) */
  pmra: number
  /** mas/yr */
  pmdec: number
  ref_epoch: number
}

export interface Grid {
  size_px: number
  pixel_scale_arcsec: number
  center_ra: number
  center_dec: number
  center_epoch: number
  orientation: string
}

/** Row 0 = top. null = no data. */
export type Pixels = (number | null)[][]

/** Why a pixel is blank: 0 valid, 1 saturated, 2 other flag, 3 no data / unknown. */
export type ReasonCode = 0 | 1 | 2 | 3

export interface Frame {
  n_images: number
  pixels: Pixels
  flagged_fraction: number
  /** one string per row (row 0 = top), one digit per pixel. Absent = no reasons known
   * (older data) or nothing blank: a null pixel then counts as code 3. */
  reasons?: string[]
  /** flag names behind the code-2 pixels, with pixel counts (most common first) */
  flags?: Record<string, number>
}

/** "D1".."D6" or "ALL" (median over every detector, the default view) */
export type FrameKey = string

export interface Epoch {
  id: string
  label: string
  mjd_start: number
  mjd_end: number
  year_mid: number
  n_images: number
  /** where the target should be this epoch, in screen pixels (integers = pixel centres) */
  predicted_px: { x: number; y: number }
  /** a detector with no usable data is omitted */
  frames: Record<FrameKey, Frame>
}

/** Measured vs predicted shift of a curated target (planetx/motion.py): a centroid estimate. */
export interface Motion {
  measurable: boolean
  /** first → last epoch, screen px; null when not measurable */
  measured_px: number | null
  predicted_px: number
  /** detector the centroid was measured in, e.g. "D6" */
  detector: string | null
  /** centroid window side (px), centred on each epoch's peak */
  window_px: number
  min_snr: number
  /** the search disc shared by all epochs */
  search: { x: number; y: number; radius_px: number }
  from_epoch: string
  to_epoch: string
  reason: null | 'saturated' | 'ambiguous' | 'faint' | 'no_data'
  centroids: { epoch: string; x: number; y: number; peak_x: number; peak_y: number; snr: number }[]
  /** same measurement on a stationary reference star (predicted 0): the method's noise floor */
  null_test: null | {
    x: number
    y: number
    measured_px: number | null
    detector: string | null
    measurable: boolean
    reason: Motion['reason']
  }
}

export interface TargetData {
  target: TargetInfo
  grid: Grid
  units: string
  generated_at: string
  collections: string[]
  n_images: number
  n_used: number
  /** wavelength range in µm per detector */
  detectors: Record<string, [number, number]>
  epochs: Epoch[]
  /** curated targets with a known proper motion only */
  motion?: Motion
}

/** Where the currently shown data came from. */
export type DataSource = { kind: 'curated'; id: string } | { kind: 'custom'; ra: number; dec: number }

/** One exposure's samples for the on-the-fly spectrum (planetx spectrum sidecar / refine). */
export interface SpectrumExposure {
  epoch: string
  detector: string
  obs_id: string
  /** wavelength (µm) at screen pixel (col, row) = wave[0] + wave[1]·(col − o) + wave[2]·(row − o),
   * o = wave_origin_px; from the exposure's spectral WCS (planetx/spectral.py) */
  wave: [number, number, number]
  /** channel bandwidth at the field centre, µm */
  bandwidth: number
  /** this exposure alone on the grid, row 0 = top, null = blank */
  pixels: Pixels
  /** blank reasons, same codes as Frame.reasons (absent: null = 3 / nothing blank) */
  reasons?: string[]
}

export interface SpectrumData {
  size_px: number
  wave_origin_px: number
  exposures: SpectrumExposure[]
}
