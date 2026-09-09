import axios from 'axios'
import { supabase } from './supabase'

// Shared axios instance for talking to the Express backend.
// In dev, baseURL is empty and Vite proxies /api -> localhost:4000.
// Production uses client/vercel.json to proxy /api to Hostinger. Keep requests
// on this origin: a legacy VITE_API_BASE_URL can point at a different auth server.
export const api = axios.create({
  baseURL: '',
})

let refreshPromise = null
let redirectingToLogin = false

function isInvalidRefresh(error) {
  return ['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found'].includes(error?.code) ||
    error?.name === 'AuthSessionMissingError'
}

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
  // Preserve the freshly refreshed token on the single retry.
  if (config._retry) return config
  const { data: { session }, error } = await supabase.auth.getSession()
  if (error) throw error

  // If session is expired or expiring within 60s, refresh it proactively.
  if (session?.expires_at && session.expires_at * 1000 < Date.now() + 60000) {
    try {
      const accessToken = await refreshAccessToken()
      config.headers.Authorization = `Bearer ${accessToken}`
      return config
    } catch (error) {
      if (isInvalidRefresh(error)) await clearInvalidSession()
      throw error
    }
  }

  if (session?.access_token) {
    config.headers.Authorization = `Bearer ${session.access_token}`
  }
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
      } catch (error) {
        if (isInvalidRefresh(error)) await clearInvalidSession()
      }
    }

    // An API rejection alone does not prove the Supabase session is revoked.
    // Preserve the login on backend failures; only Auth can invalidate it.

    return Promise.reject(err)
  }
)

// Normalize server errors into Error(message) for consistent UI handling.
// A server bug can send `error` as an object ({message, type}) instead of a
// string — never let that reach `new Error()` and render as "[object Object]".
export function apiError(err, fallback = 'Request failed') {
  const raw = err?.response?.data?.error
  const message = typeof raw === 'string' ? raw
    : raw && typeof raw === 'object' ? raw.message || JSON.stringify(raw)
    : err?.message || fallback
  return new Error(message || fallback)
}
