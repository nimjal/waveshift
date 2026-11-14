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
