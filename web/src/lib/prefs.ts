// Per-browser conveniences in localStorage. Every access is guarded: storage can be blocked
// (private windows, strict settings), and then the app just behaves like a first visit.

const GUIDE_SEEN = 'waveshift:guide-seen'

export function guideSeen(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_SEEN) === '1'
  } catch {
    return false
  }
}

export function markGuideSeen(): void {
  try {
    window.localStorage.setItem(GUIDE_SEEN, '1')
  } catch {
    // storage blocked: the guide may show again next visit
  }
}
