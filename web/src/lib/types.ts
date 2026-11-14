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
}

/** Where the currently shown data came from. */
export type DataSource = { kind: 'curated'; id: string } | { kind: 'custom'; ra: number; dec: number }
