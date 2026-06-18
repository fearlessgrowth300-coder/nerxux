import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

// Provides the current Supabase session/user to the whole app and exposes
// auth actions. `loading` is true until the initial session check resolves so
// route guards don't bounce authenticated users to /login on first paint.
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    // 1) Read any persisted session on mount.
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      setSession(data.session ?? null)
      setLoading(false)
    })

    // 2) Subscribe to future auth changes (login/logout/token refresh).
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      loading,

      // Returns { error } so pages can show inline messages.
      async signUp({ email, password }) {
        const { data, error } = await supabase.auth.signUp({ email, password })
        return { data, error }
      },

      async signIn({ email, password }) {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        })
        return { data, error }
      },

      async signOut() {
        const { error } = await supabase.auth.signOut()
        return { error }
      },
    }),
    [session, loading]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an <AuthProvider>')
  return ctx
}
