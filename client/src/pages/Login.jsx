import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function Login() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const redirectTo = location.state?.from?.pathname || '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    const { error } = await signIn({ email: email.trim(), password })
    setSubmitting(false)
    if (error) {
      setError(error.message)
      return
    }
    navigate(redirectTo, { replace: true })
  }

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your Nexus AI hub">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          autoComplete="email"
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          placeholder="••••••••"
          autoComplete="current-password"
        />

        {error && (
          <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-nexus-accent px-4 py-2.5 font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-gray-400">
        No account?{' '}
        <Link to="/signup" className="text-nexus-accent2 hover:underline">
          Create one
        </Link>
      </p>
    </AuthShell>
  )
}

// ---- Shared presentational helpers (also used by Signup) ----

export function AuthShell({ title, subtitle, children }) {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border border-nexus-border bg-nexus-panel p-8 shadow-xl">
        <div className="mb-6 text-center">
          <h1 className="bg-gradient-to-r from-nexus-accent to-nexus-accent2 bg-clip-text text-2xl font-bold text-transparent">
            Nexus AI
          </h1>
          <h2 className="mt-4 text-lg font-semibold text-gray-100">{title}</h2>
          <p className="mt-1 text-sm text-gray-400">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Field({ label, type, value, onChange, placeholder, autoComplete }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-gray-300">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required
        className="w-full rounded-lg border border-nexus-border bg-nexus-bg px-3 py-2.5 text-gray-100 outline-none transition placeholder:text-gray-600 focus:border-nexus-accent"
      />
    </label>
  )
}
