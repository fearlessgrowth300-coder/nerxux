import { Router } from 'express'
import { requireAuth } from '../lib/auth.js'
import {
  listConnections,
  setConnection,
  deleteConnection,
  isValidProvider,
  detectProvider,
} from '../lib/vault.js'

const router = Router()

// All connection routes require a valid Supabase session.
router.use(requireAuth)

// GET /api/connections — status for every provider (never returns keys).
router.get('/', async (req, res, next) => {
  try {
    const connections = await listConnections(req.user.id)
    res.json({ connections })
  } catch (err) {
    next(err)
  }
})

// POST /api/connections — paste any key; we auto-detect the provider from its
// prefix and file it there. Body: { apiKey, provider? }. `provider` is an
// optional manual override for keys we can't recognize (e.g. Higgsfield).
router.post('/', async (req, res, next) => {
  try {
    const { apiKey, provider: override } = req.body || {}
    if (!apiKey || !String(apiKey).trim()) {
      return res.status(400).json({ error: 'apiKey is required' })
    }
    const provider = override && isValidProvider(override) ? override : detectProvider(apiKey)
    if (!provider) {
      return res.status(400).json({
        error:
          "Couldn't recognize this API key. Supported: Claude (sk-ant-…), OpenAI (sk-…), " +
          'Gemini (AIza…), Groq (gsk_…), ElevenLabs (sk_…). Choose the provider manually.',
        needsProvider: true,
      })
    }
    const connection = await setConnection(req.user.id, provider, apiKey)
    res.json({ connection })
  } catch (err) {
    next(err)
  }
})

// PUT /api/connections/:provider — save (encrypt) a key. Body: { apiKey }.
router.put('/:provider', async (req, res, next) => {
  try {
    const { provider } = req.params
    if (!isValidProvider(provider)) {
      return res.status(400).json({ error: `Unknown provider: ${provider}` })
    }
    const { apiKey } = req.body || {}
    if (!apiKey || !String(apiKey).trim()) {
      return res.status(400).json({ error: 'apiKey is required' })
    }
    const status = await setConnection(req.user.id, provider, apiKey)
    res.json({ connection: status })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/connections/:provider — disconnect a provider.
router.delete('/:provider', async (req, res, next) => {
  try {
    const { provider } = req.params
    if (!isValidProvider(provider)) {
      return res.status(400).json({ error: `Unknown provider: ${provider}` })
    }
    await deleteConnection(req.user.id, provider)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
