import { Router } from 'express'
import { requireAuth } from '../lib/auth.js'
import { NATIVE_PROVIDERS } from '../lib/nativeTools.js'
import { listNative, startConnect, completeConnect, disconnectNative } from '../lib/nativeStore.js'
import { hasPlatformOAuthForNative } from '../lib/platformOAuth.js'

const router = Router()

function callbackUrlFrom(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0]
  const host = req.headers['x-forwarded-host'] || req.get('host')
  return process.env.NATIVE_OAUTH_CALLBACK || `${proto}://${host}/api/native/oauth/callback`
}

function popup(ok, message) {
  return `<!doctype html><meta charset="utf-8"><body style="background:#0b0f17;color:#e5e7eb;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh">
  <div style="text-align:center">
    <h2 style="color:${ok ? '#34d399' : '#f87171'}">${ok ? '✓ Connected' : '✗ Connection failed'}</h2>
    <p style="color:#9ca3af">${message}</p><p style="color:#6b7280;font-size:13px">You can close this window.</p>
  </div>
  <script>try{window.opener&&window.opener.postMessage({type:'native-oauth',ok:${ok}},'*')}catch(e){}setTimeout(function(){window.close()},1200)</script></body>`
}

// PUBLIC callback (browser navigation, no bearer token).
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.send(popup(false, String(error)))
  if (!code || !state) return res.send(popup(false, 'Missing code or state'))
  try {
    const r = await completeConnect(String(state), String(code))
    return res.send(popup(true, `${NATIVE_PROVIDERS[r.provider]?.label || r.provider} connected${r.channel ? ` (${r.channel})` : ''}.`))
  } catch (e) {
    return res.send(popup(false, e.message))
  }
})

router.use(requireAuth)

// The redirect URI to register with the provider's OAuth app.
router.get('/callback-url', (req, res) => res.json({ callbackUrl: callbackUrlFrom(req) }))

// List native connectors (available + connected status).
router.get('/', async (req, res, next) => {
  try {
    const connected = await listNative(req.user.id)
    const byProvider = new Map(connected.map((c) => [c.provider, c]))
    const list = Object.entries(NATIVE_PROVIDERS).map(([provider, def]) => ({
      provider,
      label: def.label,
      toolCount: def.tools.length,
      platform: hasPlatformOAuthForNative(provider), // owner set up the app → one-click
      ...(byProvider.get(provider) || { connected: false, status: 'disconnected', meta: {} }),
    }))
    res.json({ connectors: list })
  } catch (err) {
    next(err)
  }
})

// Start OAuth. Body: { clientId, clientSecret } -> { authUrl }
router.post('/:provider/connect', async (req, res, next) => {
  try {
    const { provider } = req.params
    if (!NATIVE_PROVIDERS[provider]) return res.status(400).json({ error: `Unknown provider: ${provider}` })
    const { clientId, clientSecret } = req.body || {}
    const authUrl = await startConnect(req.user.id, provider, {
      clientId,
      clientSecret,
      redirectUri: callbackUrlFrom(req),
    })
    res.json({ authUrl })
  } catch (err) {
    next(err)
  }
})

router.delete('/:provider', async (req, res, next) => {
  try {
    await disconnectNative(req.user.id, req.params.provider)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
