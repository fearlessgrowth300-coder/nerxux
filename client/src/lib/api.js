import axios from 'axios'
import { supabase } from './supabase'

// Shared axios instance for talking to the Express backend.
// In dev, baseURL is empty and Vite proxies /api -> localhost:4000.
// In prod, set VITE_API_BASE_URL to the deployed API origin.
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '',
})

// Attach the current Supabase access token to every request so the server can
// authenticate the user (see server/lib/auth.js).
api.interceptors.request.use(async (config) => {
  let {
    data: { session },
  } = await supabase.auth.getSession()

  // Auto-refresh token if it has expired or is expiring in less than 60 seconds
  if (session?.expires_at && Math.floor(Date.now() / 1000) > session.expires_at - 60) {
    try {
      const { data: refreshed } = await supabase.auth.refreshSession()
      if (refreshed?.session) {
        session = refreshed.session
      }
    } catch {}
  }

  if (session?.access_token) {
    config.headers.Authorization = `Bearer ${session.access_token}`
  }
  return config
})

// Response interceptor: automatically clear stale/expired tokens so user isn't stuck
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error?.response?.status === 401) {
      const msg = error.response?.data?.error || ''
      if (msg.includes('expired') || msg.includes('Invalid') || msg.includes('Missing')) {
        console.warn('[nexus-ai] Auth session expired. Signing out to refresh session...')
        await supabase.auth.signOut().catch(() => {})
      }
    }
    return Promise.reject(error)
  }
)

// Normalize server errors into Error(message) for consistent UI handling.
export function apiError(err, fallback = 'Request failed') {
  return new Error(err?.response?.data?.error || err?.message || fallback)
}
