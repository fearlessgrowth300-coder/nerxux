import { supabaseAdmin } from './supabase.js'

// Express middleware that authenticates a request using the Supabase access
// token sent by the client as `Authorization: Bearer <jwt>`. On success it
// attaches the verified user to req.user; otherwise it returns 401.
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) {
      return res.status(401).json({ error: 'Missing Authorization bearer token' })
    }

    // Verifies the JWT against Supabase and returns the user.
    const { data, error } = await supabaseAdmin.auth.getUser(token)
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired session' })
    }

    req.user = data.user
    next()
  } catch (err) {
    next(err)
  }
}
