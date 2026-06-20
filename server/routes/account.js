import { Router } from 'express'
import { requireAuth } from '../lib/auth.js'
import { supabaseAdmin } from '../lib/supabase.js'

const router = Router()
router.use(requireAuth)

// DELETE /api/account — permanently delete the authenticated user's account.
// Cascades remove their instructions, skills, connections, and MCP/native
// connectors (all FK to auth.users with ON DELETE CASCADE).
router.delete('/', async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user.id)
    if (error) return res.status(400).json({ error: error.message })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

export default router
