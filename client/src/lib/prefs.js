// Local, instantly-applied user preferences (profile + appearance + defaults).
// Stored per user in localStorage — no server round-trip, no failure modes.

export const ACCENT_THEMES = {
  indigo: { label: 'Indigo', accent: '99 102 241', accent2: '34 211 238' },
  violet: { label: 'Violet', accent: '139 92 246', accent2: '217 70 239' },
  emerald: { label: 'Emerald', accent: '16 185 129', accent2: '52 211 153' },
  blue: { label: 'Ocean', accent: '59 130 246', accent2: '56 189 248' },
  rose: { label: 'Rose', accent: '244 63 94', accent2: '251 146 60' },
}

export const FONTS = {
  sans: { label: 'Sans (default)', stack: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  serif: { label: 'Serif', stack: "Georgia, 'Times New Roman', 'Iowan Old Style', serif" },
}

const DEFAULTS = {
  callName: '',
  role: '',
  theme: 'indigo',
  font: 'sans',
  saveHistory: true,
}

const keyFor = (uid) => `nexus.prefs.${uid || 'anon'}`

export function getPrefs(uid) {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(keyFor(uid)) || '{}') }
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePrefs(uid, prefs) {
  try {
    localStorage.setItem(keyFor(uid), JSON.stringify(prefs))
  } catch {}
  applyAppearance(prefs)
}

// Applies appearance prefs to the document (accent color + font), live.
export function applyAppearance(prefs) {
  const root = document.documentElement
  const theme = ACCENT_THEMES[prefs?.theme] || ACCENT_THEMES.indigo
  root.style.setProperty('--nexus-accent', theme.accent)
  root.style.setProperty('--nexus-accent2', theme.accent2)
  const font = FONTS[prefs?.font] || FONTS.sans
  root.style.setProperty('--app-font', font.stack)
}
