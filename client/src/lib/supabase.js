import { createClient } from '@supabase/supabase-js'

// Single shared Supabase client for the browser.
// Uses the public anon key (safe to expose — protected by Row Level Security).
const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL || 'https://ucczqtbjunoyrhwswwou.supabase.co'
const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVjY3pxdGJqdW5veXJod3N3d291Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4MzUzMDUsImV4cCI6MjEwNDQxMTMwNX0.sikDnS7hunSSKjVHkgLxokXlA-3GZlPbJJhHTh-s4dM'

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
