import { createClient } from '@supabase/supabase-js'

// Single shared Supabase client for the browser.
// Uses the public anon key (safe to expose — protected by Row Level Security).
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  // Fail loudly in dev so a missing .env doesn't turn into confusing auth bugs.
  console.error(
    '[nexus-ai] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in client/.env'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
