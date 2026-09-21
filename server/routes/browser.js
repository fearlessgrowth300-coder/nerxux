import { Router } from 'express'
import { requireAuth } from '../lib/auth.js'
import {
  ensureBrowser,
  state,
  goto,
  screenshotJpeg,
  readText,
  clickAt,
  typeText,
  pressKey,
  scrollBy,
  stopBrowser,
  VIEWPORT_SIZE,
} from '../lib/browserSession.js'

const router = Router()

// This browser holds real logged-in sessions for the user's own accounts, and
// every route here can read or act inside them. Authentication is not optional.
router.use(requireAuth)

// GET /api/browser/state — is it up, and what page is it on.
router.get('/state', async (req, res) => {
  try {
    const s = await state()
    res.json({ ...s, viewport: VIEWPORT_SIZE })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/browser/frame — the current page as a JPEG, for the live view.
// Polled, so it must never be cached by the browser or a proxy.
router.get('/frame', async (req, res) => {
  try {
    const jpeg = await screenshotJpeg(Number(req.query.quality) || 60)
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'no-store')
    res.send(jpeg)
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

// POST /api/browser/navigate — { url }
router.post('/navigate', async (req, res) => {
  try {
    res.json(await goto(req.body?.url))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// POST /api/browser/input — the takeover channel: { type, ... }
// click {x,y} · text {text} · key {key} · scroll {deltaY}
// Coordinates are page pixels in the fixed viewport; the client scales from
// its rendered <img> so a resized panel still clicks the right spot.
router.post('/input', async (req, res) => {
  const { type, x, y, text, key, deltaY } = req.body || {}
  try {
    if (type === 'click') await clickAt(Number(x), Number(y))
    else if (type === 'text') await typeText(text)
    else if (type === 'key') await pressKey(String(key))
    else if (type === 'scroll') await scrollBy(Number(deltaY) || 600)
    else return res.status(400).json({ error: `Unknown input type "${type}"` })
    res.json(await state())
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// POST /api/browser/start — open the browser without navigating anywhere.
router.post('/start', async (req, res) => {
  try {
    res.json(await ensureBrowser())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/browser/text — the current page as text, for debugging what the
// agent is actually seeing.
router.get('/text', async (req, res) => {
  try {
    res.json(await readText())
  } catch (err) {
    res.status(503).json({ error: err.message })
  }
})

// POST /api/browser/stop — shut the browser down. Logins survive: they live in
// the profile directory on disk, not in the running process.
router.post('/stop', async (req, res) => {
  try {
    res.json(await stopBrowser())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
