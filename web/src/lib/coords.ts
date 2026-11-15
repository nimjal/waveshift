// Parse user-typed coordinates. Accepts decimal degrees ("133.8189") or
// sexagesimal: RA in hours ("08 55 10.83", "08:55:10.83", "8h55m10.8s"),
// Dec in degrees ("-07 14 42.5", "-07:14:42.5", "-7d14m42.5s").

function parseSexagesimal(text: string): { sign: number; value: number } | null {
  const s = text.trim().toLowerCase()
  const sign = s.startsWith('-') || s.startsWith('−') ? -1 : 1
  const body = s.replace(/^[+\-−]/, '')
  const parts = body
    .replace(/[hdms°′″'"]/g, ' ')
    .replace(/:/g, ' ')
    .trim()
    .split(/\s+/)
  if (parts.length < 2 || parts.length > 3) return null
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  const [a, b, c = 0] = nums
  if (b >= 60 || c >= 60) return null
  return { sign, value: a + b / 60 + c / 3600 }
}

const DECIMAL = /^[+\-−]?\d+(\.\d*)?$|^[+\-−]?\.\d+$/

/** RA in degrees, or NaN if unparseable. Decimal input = degrees; sexagesimal = hours. */
export function parseRa(text: string): number {
  const s = text.trim().replace('−', '-')
  if (!s) return NaN
  if (DECIMAL.test(s)) return Number(s)
  const sx = parseSexagesimal(s)
  if (!sx || sx.sign < 0) return NaN
  return sx.value * 15
}

/** Dec in degrees, or NaN if unparseable. */
export function parseDec(text: string): number {
  const s = text.trim().replace('−', '-')
  if (!s) return NaN
  if (DECIMAL.test(s)) return Number(s)
  const sx = parseSexagesimal(s)
  if (!sx) return NaN
  return sx.sign * sx.value
}

/** Sky position (degrees, ICRS) of a screen pixel on the blink grid: a tangent-plane (TAN)
 * projection centred on the middle pixel, north up, east left, row 0 = top
 * (planetx/stack.py make_grid). Sub-pixel x / y are allowed. */
export function pixelToSky(
  grid: { size_px: number; pixel_scale_arcsec: number; center_ra: number; center_dec: number },
  x: number,
  y: number,
): { ra: number; dec: number } {
  const rad = Math.PI / 180
  const o = (grid.size_px - 1) / 2
  const step = (grid.pixel_scale_arcsec / 3600) * rad
  const xi = -(x - o) * step // east is to the left
  const eta = (o - y) * step // north is up
  const d0 = grid.center_dec * rad
  const den = Math.cos(d0) - eta * Math.sin(d0)
  const ra = grid.center_ra + Math.atan2(xi, den) / rad
  const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, den)) / rad
  return { ra: ((ra % 360) + 360) % 360, dec }
}
