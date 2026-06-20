import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { api, apiError } from '../lib/api'
import { getPrefs, savePrefs, ACCENT_THEMES, FONTS } from '../lib/prefs'
import {
  SettingsIcon, ConnectionsIcon, InstructionsIcon, SkillsIcon, SearchIcon, LogoutIcon,
} from '../components/icons'
import { CHAT_MODELS } from '@shared/models'
import Modal from '../components/Modal'

const SECTIONS = [
  { id: 'general', label: 'General', Icon: SettingsIcon },
  { id: 'appearance', label: 'Appearance', Icon: SearchIcon },
  { id: 'account', label: 'Account', Icon: LogoutIcon },
  { id: 'privacy', label: 'Privacy', Icon: InstructionsIcon },
  { id: 'capabilities', label: 'Capabilities', Icon: SkillsIcon },
  { id: 'connections', label: 'Connections', Icon: ConnectionsIcon },
]

export default function Settings() {
  const { user } = useAuth()
  const [active, setActive] = useState('general')
  const [query, setQuery] = useState('')
  const [prefs, setPrefs] = useState(() => getPrefs(user?.id))

  useEffect(() => setPrefs(getPrefs(user?.id)), [user?.id])

  function update(patch) {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    savePrefs(user?.id, next)
  }

  const filtered = useMemo(
    () => SECTIONS.filter((s) => s.label.toLowerCase().includes(query.toLowerCase())),
    [query]
  )

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl gap-6 px-4 py-6 md:py-8">
      {/* Left nav */}
      <aside className="w-52 shrink-0">
        <h1 className="mb-4 px-2 text-xl font-semibold text-gray-100">Settings</h1>
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-nexus-border bg-nexus-panel px-2 py-1.5">
          <SearchIcon className="h-4 w-4 text-gray-500" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search"
            className="w-full bg-transparent text-sm text-gray-200 outline-none placeholder:text-gray-600" />
        </div>
        <nav className="space-y-0.5">
          {filtered.map((s) => (
            <button key={s.id} onClick={() => setActive(s.id)}
              className={['flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition',
                active === s.id ? 'bg-nexus-accent/15 text-white' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'].join(' ')}>
              <s.Icon className="h-4 w-4" /> {s.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Panel */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {active === 'general' && <General prefs={prefs} update={update} />}
        {active === 'appearance' && <Appearance prefs={prefs} update={update} />}
        {active === 'account' && <Account />}
        {active === 'privacy' && <Privacy />}
        {active === 'capabilities' && <Capabilities />}
        {active === 'connections' && <ConnectionsSection />}
      </div>
    </div>
  )
}

/* ---------------- General ---------------- */
function General({ prefs, update }) {
  const { user } = useAuth()
  return (
    <Section title="Profile">
      <Row label="Email"><span className="text-gray-200">{user?.email}</span></Row>
      <Field label="What should we call you?" value={prefs.callName}
        onChange={(v) => update({ callName: v })} placeholder="Your name" />
      <Field label="What best describes your work?" value={prefs.role}
        onChange={(v) => update({ role: v })} placeholder="e.g. Marketer, Developer" />
      <p className="pt-2 text-xs text-gray-500">
        Your global instructions for the AI live in{' '}
        <a href="/instructions" className="text-nexus-accent2 hover:underline">Instructions</a>.
      </p>
    </Section>
  )
}

/* ---------------- Appearance ---------------- */
function Appearance({ prefs, update }) {
  return (
    <Section title="Appearance">
      <div>
        <p className="mb-2 text-sm text-gray-300">Accent theme</p>
        <div className="flex flex-wrap gap-2">
          {Object.entries(ACCENT_THEMES).map(([id, t]) => (
            <button key={id} onClick={() => update({ theme: id })}
              className={['flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition',
                prefs.theme === id ? 'border-nexus-accent text-white' : 'border-nexus-border text-gray-400 hover:bg-white/5'].join(' ')}>
              <span className="h-4 w-4 rounded-full" style={{ background: `rgb(${t.accent})` }} />
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="pt-2">
        <p className="mb-2 text-sm text-gray-300">Chat font</p>
        <select value={prefs.font} onChange={(e) => update({ font: e.target.value })}
          className="rounded-lg border border-nexus-border bg-nexus-bg px-3 py-2 text-sm text-gray-100 outline-none focus:border-nexus-accent">
          {Object.entries(FONTS).map(([id, f]) => <option key={id} value={id}>{f.label}</option>)}
        </select>
      </div>
      <p className="pt-1 text-xs text-gray-500">Changes apply instantly across the app.</p>
    </Section>
  )
}

/* ---------------- Account ---------------- */
function Account() {
  const { user, signOut } = useAuth()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const projectId = (import.meta.env.VITE_SUPABASE_URL || '').replace('https://', '').split('.')[0]

  async function logoutAll() {
    setBusy('all')
    try { await supabase.auth.signOut({ scope: 'global' }) } finally { setBusy('') }
  }
  async function del() {
    setBusy('delete'); setError('')
    try {
      await api.delete('/api/account')
      await signOut()
    } catch (e) {
      setError(apiError(e).message); setBusy('')
    }
  }

  return (
    <Section title="Account">
      {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>}
      <Row label="User ID"><span className="font-mono text-xs text-gray-400">{user?.id}</span></Row>
      <Row label="Project ID"><span className="font-mono text-xs text-gray-400">{projectId}</span></Row>

      <div className="pt-2">
        <p className="mb-2 text-sm font-medium text-gray-200">Current session</p>
        <div className="rounded-lg border border-nexus-border bg-nexus-panel p-3 text-sm">
          <p className="text-gray-200">{user?.email}</p>
          <p className="mt-0.5 truncate text-xs text-gray-500">{navigator.userAgent}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 pt-2">
        <button onClick={signOut} className="rounded-lg border border-nexus-border px-4 py-2 text-sm text-gray-200 transition hover:bg-white/5">Log out</button>
        <button onClick={logoutAll} disabled={busy === 'all'} className="rounded-lg border border-nexus-border px-4 py-2 text-sm text-gray-200 transition hover:bg-white/5 disabled:opacity-50">
          {busy === 'all' ? '…' : 'Log out of all devices'}
        </button>
      </div>

      <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
        <p className="text-sm font-medium text-red-300">Delete account</p>
        <p className="mt-1 text-xs text-gray-400">Permanently deletes your account, instructions, skills, and connections. This can't be undone.</p>
        <button onClick={() => setConfirmDelete(true)} className="mt-3 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-500">Delete account</button>
      </div>

      <Modal open={confirmDelete} onClose={() => busy !== 'delete' && setConfirmDelete(false)} title="Delete account?"
        footer={<>
          <button onClick={() => setConfirmDelete(false)} disabled={busy === 'delete'} className="rounded-lg border border-nexus-border px-4 py-2 text-sm text-gray-300 hover:bg-white/5 disabled:opacity-50">Cancel</button>
          <button onClick={del} disabled={busy === 'delete'} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50">{busy === 'delete' ? 'Deleting…' : 'Delete forever'}</button>
        </>}>
        <p className="text-sm text-gray-300">This permanently deletes <span className="font-medium text-gray-100">{user?.email}</span> and all associated data.</p>
      </Modal>
    </Section>
  )
}

/* ---------------- Privacy ---------------- */
function Privacy() {
  const { user } = useAuth()
  const [save, setSave] = useState(() => getPrefs(user?.id).saveHistory)
  const [cleared, setCleared] = useState(false)

  function toggleSave() {
    const next = !save
    setSave(next)
    const p = getPrefs(user?.id)
    savePrefs(user?.id, { ...p, saveHistory: next })
  }
  function clearChats() {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(`nexus.chat.${user?.id}`)) localStorage.removeItem(k)
    }
    setCleared(true)
  }

  return (
    <Section title="Privacy">
      <ToggleRow label="Save chat history on this device"
        desc="Keep your conversations in this browser so they're here when you return."
        on={save} onClick={toggleSave} />
      <div className="pt-2">
        <p className="text-sm font-medium text-gray-200">Clear conversations</p>
        <p className="mt-1 text-xs text-gray-400">Remove all saved chats from this browser.</p>
        <button onClick={clearChats} className="mt-3 rounded-lg border border-nexus-border px-4 py-2 text-sm text-gray-200 transition hover:bg-white/5">
          {cleared ? 'Cleared ✓' : 'Clear all chats'}
        </button>
      </div>
      <p className="pt-2 text-xs text-gray-500">Your API keys and connectors are encrypted on the server and never exposed to the browser.</p>
    </Section>
  )
}

/* ---------------- Capabilities ---------------- */
function Capabilities() {
  const { user } = useAuth()
  const key = `nexus.chatModels.${user?.id || 'anon'}`
  const [s, setS] = useState(() => { try { return JSON.parse(localStorage.getItem(key) || '{}') } catch { return {} } })
  function update(patch) {
    const next = { ...s, ...patch }
    setS(next)
    try { localStorage.setItem(key, JSON.stringify(next)) } catch {}
  }
  return (
    <Section title="Capabilities">
      <p className="text-sm text-gray-400">Defaults applied to new chats.</p>
      <div className="pt-1">
        <p className="mb-1 text-sm text-gray-300">Default model</p>
        <select value={s.modelA || 'claude-sonnet'} onChange={(e) => update({ modelA: e.target.value })}
          className="rounded-lg border border-nexus-border bg-nexus-bg px-3 py-2 text-sm text-gray-100 outline-none focus:border-nexus-accent">
          {CHAT_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </div>
      <ToggleRow label="Web search by default" desc="Let the AI search the web (via Claude) when helpful."
        on={Boolean(s.webSearch)} onClick={() => update({ webSearch: !s.webSearch })} />
      <ToggleRow label="Auto-route by default" desc="The intent router picks the right tool for each message."
        on={Boolean(s.auto)} onClick={() => update({ auto: !s.auto })} />
      <ToggleRow label="Pipeline mode by default" desc="Chain Model A (analyst) → Model B (executor) when two models are set."
        on={Boolean(s.pipeline)} onClick={() => update({ pipeline: !s.pipeline })} />
    </Section>
  )
}

/* ---------------- Connections ---------------- */
function ConnectionsSection() {
  const navigate = useNavigate()
  return (
    <Section title="Connections">
      <p className="text-sm text-gray-400">Manage provider API keys, MCP connectors, and app integrations (YouTube, etc.).</p>
      <button onClick={() => navigate('/connections')} className="rounded-lg bg-nexus-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500">
        Open Connections
      </button>
    </Section>
  )
}

/* ---------------- shared bits ---------------- */
function Section({ title, children }) {
  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold text-gray-100">{title}</h2>
      <div className="space-y-4">{children}</div>
    </div>
  )
}
function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-nexus-border/60 py-2">
      <span className="text-sm text-gray-400">{label}</span>
      {children}
    </div>
  )
}
function Field({ label, value, onChange, placeholder }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-gray-300">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full max-w-md rounded-lg border border-nexus-border bg-nexus-bg px-3 py-2.5 text-sm text-gray-100 outline-none transition placeholder:text-gray-600 focus:border-nexus-accent" />
    </label>
  )
}
function ToggleRow({ label, desc, on, onClick }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm text-gray-200">{label}</p>
        {desc && <p className="mt-0.5 text-xs text-gray-500">{desc}</p>}
      </div>
      <button onClick={onClick} role="switch" aria-checked={on}
        className={['relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition', on ? 'bg-nexus-accent' : 'bg-gray-600'].join(' ')}>
        <span className={['inline-block h-4 w-4 transform rounded-full bg-white transition', on ? 'translate-x-4' : 'translate-x-0.5'].join(' ')} />
      </button>
    </div>
  )
}
