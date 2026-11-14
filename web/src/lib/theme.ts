// Light / dark mode. The class on <html> is set before first paint by the inline script in
// index.html (same key), so this module only reads and flips it.
const KEY = 'waveshift:theme'

export type Theme = 'light' | 'dark'

export function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  try {
    window.localStorage.setItem(KEY, theme)
  } catch {
    // storage blocked: the choice lasts for this visit only
  }
}
