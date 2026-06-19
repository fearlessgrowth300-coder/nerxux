import { Router } from 'express'
import { requireAuth } from '../lib/auth.js'
import {
  listConnectors,
  addConnector,
  refreshConnector,
  setConnectorEnabled,
  setToolPermission,
  deleteConnector,
  startOAuth,
  completeOAuth,
} from '../lib/mcpStore.js'

const router = Router()

// Renders a tiny page that signals the opener window and closes the popup.
function popupResult(ok, message) {
  return `<!doctype html><meta charset="utf-8"><body style="background:#0b0f17;color:#e5e7eb;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh">
  <div style="text-align:center">
    <h2 style="color:${ok ? '#34d399' : '#f87171'}">${ok ? '✓ Connected' : '✗ Connection failed'}</h2>
    <p style="color:#9ca3af">${message}</p>
    <p style="color:#6b7280;font-size:13px">You can close this window.</p>
  </div>
  <script>
    try { window.opener && window.opener.postMessage({ type: 'mcp-oauth', ok: ${ok} }, '*') } catch (e) {}
    setTimeout(function(){ window.close() }, 1200)
  </script></body>`
}

// PUBLIC — the MCP server redirects the browser here after the user authorizes.
// No bearer token is present on this navigation, so it sits before requireAuth.
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.send(popupResult(false, String(error)))
  if (!code || !state) return res.send(popupResult(false, 'Missing code or state'))
  try {
    const result = await completeOAuth(String(state), String(code))
    if (result.status === 'connected') {
      return res.send(popupResult(true, `${result.name} is connected.`))
    }
    return res.send(popupResult(false, `Authorized, but tool discovery failed.`))
  } catch (e) {
    return res.send(popupResult(false, e.message))
  }
})

// Everything below requires a valid session.
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

// POST /api/mcp/:id/authorize — begin the OAuth flow; returns { authUrl } to
// open in a popup, or { authorized: true } if tokens already exist.
router.post('/:id/authorize', async (req, res, next) => {
  try {
    res.json(await startOAuth(req.user.id, req.params.id))
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

// PATCH /api/mcp/:id/tool — set a per-tool permission. Body: { tool, perm }
router.patch('/:id/tool', async (req, res, next) => {
  try {
    const { tool, perm } = req.body || {}
    if (!tool || !['allow', 'approval', 'blocked'].includes(perm)) {
      return res.status(400).json({ error: 'tool and a valid perm are required' })
    }
    res.json({ connector: await setToolPermission(req.user.id, req.params.id, tool, perm) })
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
