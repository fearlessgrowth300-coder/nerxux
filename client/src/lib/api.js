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
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (session?.access_token) {
    config.headers.Authorization = `Bearer ${session.access_token}`
  }
  return config
})

// Normalize server errors into Error(message) for consistent UI handling.
export function apiError(err, fallback = 'Request failed') {
  return new Error(err?.response?.data?.error || err?.message || fallback)
}
