import { Router } from 'express'
import { requireAuth } from '../lib/auth.js'
import {
  listConnectors,
  addConnector,
  refreshConnector,
  setConnectorEnabled,
  deleteConnector,
} from '../lib/mcpStore.js'

const router = Router()
router.use(requireAuth)

// GET /api/mcp — list the user's MCP connectors (with cached tools + status).
router.get('/', async (req, res, next) => {
  try {
    res.json({ connectors: await listConnectors(req.user.id) })
  } catch (err) {
    next(err)
  }
})

// POST /api/mcp — add a custom connector. Body: { name, url, oauthClientId?, oauthSecret? }
router.post('/', async (req, res, next) => {
  try {
    const { name, url, oauthClientId, oauthSecret } = req.body || {}
    const connector = await addConnector(req.user.id, {
      name,
      url,
      oauthClientId,
      oauthSecret,
    })
    res.json({ connector })
  } catch (err) {
    next(err)
  }
})

// POST /api/mcp/:id/refresh — reconnect and re-discover tools.
router.post('/:id/refresh', async (req, res, next) => {
  try {
    res.json({ connector: await refreshConnector(req.user.id, req.params.id) })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/mcp/:id — enable/disable. Body: { enabled }
router.patch('/:id', async (req, res, next) => {
  try {
    const connector = await setConnectorEnabled(
      req.user.id,
      req.params.id,
      Boolean(req.body?.enabled)
    )
    res.json({ connector })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/mcp/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await deleteConnector(req.user.id, req.params.id)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
