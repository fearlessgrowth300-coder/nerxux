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
  try {
    let {
      data: { session },
    } = await supabase.auth.getSession()

    // If session is expired or expiring within 60s, refresh it proactively
    if (session?.expires_at && session.expires_at * 1000 < Date.now() + 60000) {
      const { data: refreshed } = await supabase.auth.refreshSession()
      if (refreshed?.session) {
        session = refreshed.session
      }
    }

    if (session?.access_token) {
      config.headers.Authorization = `Bearer ${session.access_token}`
    }
  } catch {}
  return config
})

// Proactive 401 retry: if a request gets 401 due to expired session, refresh and retry once
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config
    if (
      err.response?.status === 401 &&
      !original?._retry &&
      (err.response?.data?.error?.includes('session') ||
        err.response?.data?.error?.includes('expired') ||
        err.response?.data?.error?.includes('token'))
    ) {
      original._retry = true
      try {
        const { data } = await supabase.auth.refreshSession()
        if (data?.session?.access_token) {
          original.headers.Authorization = `Bearer ${data.session.access_token}`
          return api(original)
        }
      } catch {}
    }
    return Promise.reject(err)
  }
)

// Normalize server errors into Error(message) for consistent UI handling.
export function apiError(err, fallback = 'Request failed') {
  return new Error(err?.response?.data?.error || err?.message || fallback)
}
