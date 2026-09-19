import { supabaseAdmin } from './supabase.js'

// A chat poll lands every 2s, and the VPS's outbound connections to Supabase
// time out now and then. Caching a verified token briefly means one lookup a
// minute per user instead of thirty, so a blip rarely reaches a request at all.
const CACHE_MS = 60_000
const verified = new Map() // token -> { user, until }

// Express middleware that authenticates a request using the Supabase access
// token sent by the client as `Authorization: Bearer <jwt>`. On success it
// attaches the verified user to req.user; a rejected token gets 401, and a
// failure to REACH Supabase gets 503 so the client retries instead of
// treating the user as logged out.
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) {
      return res.status(401).json({ error: 'Missing Authorization bearer token' })
    }

    const now = Date.now()
    const hit = verified.get(token)
    if (hit && hit.until > now) {
      req.user = hit.user
      return next()
    }

    // Verifies the JWT against Supabase and returns the user.
    const { data, error } = await supabaseAdmin.auth.getUser(token)
    if (error && (error.name === 'AuthRetryableFetchError' || !error.status || error.status >= 500)) {
      console.warn('[nexus-ai auth] Supabase unreachable, asking client to retry:', error.message)
      return res.status(503).json({ error: 'Could not verify your session right now. Retrying…' })
    }
    if (error || !data?.user) {
      console.warn('[nexus-ai auth] Invalid or expired token:', error?.message)
      return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' })
    }

    if (verified.size > 500) {
      for (const [t, v] of verified) if (v.until <= now) verified.delete(t)
    }
    verified.set(token, { user: data.user, until: now + CACHE_MS })
    req.user = data.user
    next()
  } catch (err) {
    next(err)
  }
}
