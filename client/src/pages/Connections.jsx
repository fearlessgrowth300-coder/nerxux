import { useEffect, useState } from 'react'
import PageShell from '../components/PageShell'
import {
  getConnections,
  saveConnection,
  removeConnection,
} from '../lib/connections'

// Helper text per provider: where to get the key.
const HINTS = {
  claude: 'console.anthropic.com → API Keys',
  openai: 'platform.openai.com → API Keys',
  gemini: 'aistudio.google.com → Get API key',
  elevenlabs: 'elevenlabs.io → Profile → API Key',
  higgsfield: 'higgsfield.ai → account settings',
}

export default function Connections() {
  const [connections, setConnections] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Per-provider local input + busy state.
  const [inputs, setInputs] = useState({})
  const [busy, setBusy] = useState(null)

  async function refresh() {
    setLoading(true)
    setError('')
    try {
      setConnections(await getConnections())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  async function handleSave(provider) {
    const apiKey = (inputs[provider] || '').trim()
    if (!apiKey) return
    setBusy(provider)
    setError('')
    try {
      await saveConnection(provider, apiKey)
      setInputs((p) => ({ ...p, [provider]: '' }))
      await refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function handleDisconnect(provider) {
    setBusy(provider)
    setError('')
    try {
      await removeConnection(provider)
      await refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageShell
      title="Connections"
      description="Connect provider API keys. Keys are encrypted on the server and never sent back to your browser."
    >
      {error && (
        <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-white/5" />
          ))}
        </div>
      ) : (
        <ul className="space-y-3">
          {connections.map((c) => (
            <li
              key={c.provider}
              className="rounded-xl border border-nexus-border bg-nexus-panel p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <h3 className="font-medium text-gray-100">{c.label}</h3>
                  <StatusBadge connected={c.connected} />
                </div>
                {c.connected && (
                  <button
                    onClick={() => handleDisconnect(c.provider)}
                    disabled={busy === c.provider}
                    className="rounded-lg px-3 py-1.5 text-sm text-red-400 transition hover:bg-red-500/10 disabled:opacity-50"
                  >
                    {busy === c.provider ? '…' : 'Disconnect'}
                  </button>
                )}
              </div>

              {c.connected ? (
                <p className="mt-2 text-sm text-gray-400">
                  Key saved ending in{' '}
                  <span className="font-mono text-gray-200">••••{c.last4}</span>
                  {c.updated_at && (
                    <span className="text-gray-600">
                      {' '}
                      · updated {new Date(c.updated_at).toLocaleDateString()}
                    </span>
                  )}
                </p>
              ) : (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input
                    type="password"
                    value={inputs[c.provider] || ''}
                    onChange={(e) =>
                      setInputs((p) => ({ ...p, [c.provider]: e.target.value }))
                    }
                    onKeyDown={(e) => e.key === 'Enter' && handleSave(c.provider)}
                    placeholder={`Paste ${c.label} API key`}
                    className="flex-1 rounded-lg border border-nexus-border bg-nexus-bg px-3 py-2.5 text-sm text-gray-100 outline-none transition placeholder:text-gray-600 focus:border-nexus-accent"
                  />
                  <button
                    onClick={() => handleSave(c.provider)}
                    disabled={busy === c.provider || !(inputs[c.provider] || '').trim()}
                    className="rounded-lg bg-nexus-accent px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy === c.provider ? 'Saving…' : 'Connect'}
                  </button>
                </div>
              )}

              <p className="mt-2 text-xs text-gray-600">
                Get a key: {HINTS[c.provider]}
              </p>
            </li>
          ))}
        </ul>
      )}

      {/* OAuth placeholder for future services */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-gray-300">
          OAuth connections{' '}
          <span className="ml-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">
            coming soon
          </span>
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          Sign-in-based connections for services that use OAuth.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {['Google Drive', 'Notion', 'Slack', 'GitHub'].map((name) => (
            <button
              key={name}
              disabled
              className="flex cursor-not-allowed items-center justify-between rounded-xl border border-dashed border-nexus-border bg-nexus-panel/40 px-4 py-3 text-left opacity-70"
            >
              <span className="text-sm text-gray-300">{name}</span>
              <span className="text-xs text-gray-600">Connect</span>
            </button>
          ))}
        </div>
      </section>
    </PageShell>
  )
}

function StatusBadge({ connected }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        connected
          ? 'bg-emerald-500/10 text-emerald-400'
          : 'bg-gray-500/10 text-gray-400',
      ].join(' ')}
    >
      <span
        className={[
          'h-1.5 w-1.5 rounded-full',
          connected ? 'bg-emerald-400' : 'bg-gray-500',
        ].join(' ')}
      />
      {connected ? 'Connected' : 'Not connected'}
    </span>
  )
}
