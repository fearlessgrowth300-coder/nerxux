// Spoken replies via the browser's built-in speech synthesis — works offline,
// no API key, on every modern desktop/mobile browser. (ElevenLabs stays what
// it is today: a generation tool the model can call for produced audio.)

export const speechOutputSupported =
  typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window

// Markdown reads terribly aloud — strip the syntax, keep the words.
export function speakableText(markdown = '') {
  return String(markdown)
    .replace(/```[\s\S]*?```/g, ' (code block omitted) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()
}

let current = null

export function stopSpeaking() {
  if (!speechOutputSupported) return
  current = null
  window.speechSynthesis.cancel()
}

// Speaks `text`; resolves when it finishes (or is cancelled / unsupported).
export function speak(text) {
  return new Promise((resolve) => {
    if (!speechOutputSupported) return resolve(false)
    const clean = speakableText(text)
    if (!clean) return resolve(false)
    stopSpeaking()
    const u = new SpeechSynthesisUtterance(clean)
    u.rate = 1.02
    // Prefer a natural-sounding English voice when the browser offers one.
    const voices = window.speechSynthesis.getVoices()
    u.voice =
      voices.find((v) => /en/i.test(v.lang) && /natural|neural|premium|enhanced/i.test(v.name)) ||
      voices.find((v) => /^en/i.test(v.lang)) || null
    u.onend = () => { if (current === u) current = null; resolve(true) }
    u.onerror = () => { if (current === u) current = null; resolve(false) }
    current = u
    window.speechSynthesis.speak(u)
  })
}

export function isSpeaking() {
  return Boolean(current) && speechOutputSupported && window.speechSynthesis.speaking
}
