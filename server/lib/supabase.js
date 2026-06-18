import { createClient } from '@supabase/supabase-js'

// Server-side Supabase client using the SERVICE ROLE key. This bypasses Row
// Level Security, so it must only ever be used on the backend and queries must
// always be explicitly scoped by user_id (the auth middleware provides it).
const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  console.error(
    '[nexus-ai] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in server/.env'
  )
}

export const supabaseAdmin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
