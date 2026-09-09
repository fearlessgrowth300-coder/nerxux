import axios from 'axios'
import { supabase } from './supabase'

// Shared axios instance for talking to the Express backend.
// In dev, baseURL is empty and Vite proxies /api -> localhost:4000.
// In prod, set VITE_API_BASE_URL to the deployed API origin.
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '',
})

let refreshPromise = null
let redirectingToLogin = false

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = supabase.auth
      .refreshSession()
      .then(({ data, error }) => {
        if (error || !data?.session?.access_token) {
          throw error || new Error('Session refresh returned no access token')
        }
        return data.session.access_token
      })
      .finally(() => {
        refreshPromise = null
      })
  }
  return refreshPromise
}

async function clearInvalidSession() {
  try {
    await supabase.auth.signOut({ scope: 'local' })
  } catch {}

  if (
    typeof window !== 'undefined' &&
    !redirectingToLogin &&
    window.location.pathname !== '/login'
  ) {
    redirectingToLogin = true
    window.sessionStorage.setItem(
      'nexus.auth.notice',
      'Your saved session could not be refreshed. Please sign in again.'
    )
    window.location.assign('/login')
  }
}

// Attach the current Supabase access token to every request so the server can
// authenticate the user (see server/lib/auth.js).
api.interceptors.request.use(async (config) => {
  try {
    let {
      data: { session },
    } = await supabase.auth.getSession()

    // If session is expired or expiring within 60s, refresh it proactively
    if (session?.expires_at && session.expires_at * 1000 < Date.now() + 60000) {
      try {
        const accessToken = await refreshAccessToken()
        config.headers.Authorization = `Bearer ${accessToken}`
        return config
      } catch {
        await clearInvalidSession()
        return config
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
    const authMessage = String(err.response?.data?.error || '')
    if (
      err.response?.status === 401 &&
      original &&
      !original._retry &&
      /(session|expired|token|authorization)/i.test(authMessage)
    ) {
      original._retry = true
      try {
        const accessToken = await refreshAccessToken()
        original.headers.Authorization = `Bearer ${accessToken}`
        return api(original)
      } catch {
        await clearInvalidSession()
      }
    }

    // A refreshed token that is also rejected cannot be recovered without a
    // new login. Clear it instead of leaving the app in a permanent 401 loop.
    if (
      err.response?.status === 401 &&
      original?._retry &&
      /(session|expired|token|authorization)/i.test(authMessage)
    ) {
      await clearInvalidSession()
    }

    return Promise.reject(err)
  }
)

// Normalize server errors into Error(message) for consistent UI handling.
export function apiError(err, fallback = 'Request failed') {
  return new Error(err?.response?.data?.error || err?.message || fallback)
}
