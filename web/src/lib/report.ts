// "Spotted a mover?": links for checking a marked pixel against a catalogue and for reporting it.

export const REPO_URL = 'https://github.com/nimjal/waveshift'

/** SIMBAD lists positions for epoch 2000. The fastest known star (Barnard's) has moved about
 * 4.5 arcmin since then, so the search radius has to be this wide to find a known fast mover
 * at the place SPHEREx sees it today. */
export const SIMBAD_RADIUS_ARCMIN = 5

/** SIMBAD coordinate search around a position (Harvard mirror: the CDS host did not answer in
 * Nov 2026; both serve the same database). */
export function simbadUrl(ra: number, dec: number): string {
  const coord = `${ra.toFixed(5)}d ${dec >= 0 ? '+' : ''}${dec.toFixed(5)}d`
  const q = new URLSearchParams({
    Coord: coord,
    CooFrame: 'ICRS',
    Radius: String(SIMBAD_RADIUS_ARCMIN),
    'Radius.unit': 'arcmin',
  })
  return `https://simbad.harvard.edu/simbad/sim-coo?${q}`
}

export interface Candidate {
  /** link that reopens this exact view with the pixel marked */
  viewUrl: string
  ra: number
  dec: number
  /** e.g. "x 14, y 9" */
  pixel: string
  field: string
  detector: string
  epochs: string
}

/** A new GitHub issue from the "Candidate report" form (.github/ISSUE_TEMPLATE/candidate-report.yml)
 * with the view pre-filled: issue forms take field values from query parameters named by field id. */
export function candidateReportUrl(c: Candidate): string {
  const pos = `RA ${c.ra.toFixed(5)}°, Dec ${c.dec >= 0 ? '+' : ''}${c.dec.toFixed(5)}° (ICRS) · pixel ${c.pixel}`
  const q = new URLSearchParams({
    template: 'candidate-report.yml',
    title: `Candidate: RA ${c.ra.toFixed(4)} Dec ${c.dec >= 0 ? '+' : ''}${c.dec.toFixed(4)}`,
    'view-link': c.viewUrl,
    position: pos,
    view: `${c.field} · ${c.detector} · visits: ${c.epochs}`,
  })
  return `${REPO_URL}/issues/new?${q}`
}
