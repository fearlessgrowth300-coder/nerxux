import { Router } from 'express'
import { requireAuth } from '../lib/auth.js'
import {
  listConnections,
  setConnection,
  deleteConnection,
  isValidProvider,
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
