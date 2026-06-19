import { useEffect, useState } from 'react'
import PageShell from '../components/PageShell'
import Modal from '../components/Modal'
import {
  getConnections,
  saveConnection,
  removeConnection,
} from '../lib/connections'
import {
  getConnectors,
  getCallbackUrl,
  addConnector,
  authorizeConnector,
  refreshConnector,
  setConnectorEnabled,
  setToolPermission,
  removeConnector,
} from '../lib/mcp'

const HINTS = {
  claude: 'console.anthropic.com → API Keys',
  openai: 'platform.openai.com → API Keys',
  gemini: 'aistudio.google.com → Get API key',
  elevenlabs: 'elevenlabs.io → Profile → API Key',
  higgsfield: 'higgsfield.ai → account settings',
}

export default function Connections() {
  return (
    <PageShell
      title="Connections"
      description="Connect provider API keys and custom MCP servers. Keys are encrypted on the server and never sent back to your browser."
    >
      <ApiKeyVault />
      <McpConnectors />
    </PageShell>
  )
}

/* ----------------------- Provider API key vault ----------------------- */

function ApiKeyVault() {
  const [connections, setConnections] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
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
    <section>
      <h2 className="mb-3 text-sm font-semibold text-gray-300">Provider API keys</h2>
      {error && (
        <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
      )}
      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-white/5" />
          ))}
        </div>
      ) : (
        <ul className="space-y-3">
          {connections.map((c) => (
            <li key={c.provider} className="rounded-xl border border-nexus-border bg-nexus-panel p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <h3 className="font-medium text-gray-100">{c.label}</h3>
                  <StatusDot connected={c.connected} on="Connected" off="Not connected" />
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
                  Key saved ending in <span className="font-mono text-gray-200">••••{c.last4}</span>
                </p>
              ) : (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input
                    type="password"
                    value={inputs[c.provider] || ''}
                    onChange={(e) => setInputs((p) => ({ ...p, [c.provider]: e.target.value }))}
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
              <p className="mt-2 text-xs text-gray-600">Get a key: {HINTS[c.provider]}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* ----------------------- MCP connectors ----------------------- */

const EMPTY_FORM = { name: '', url: '', oauthClientId: '', oauthSecret: '' }

function McpConnectors() {
  const [connectors, setConnectors] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(null)
  const [expanded, setExpanded] = useState(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  async function refresh() {
    setLoading(true)
    setError('')
    try {
      setConnectors(await getConnectors())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    refresh()
    getCallbackUrl().then((u) => u && setCallbackUrl(u))
  }, [])

  // When the OAuth popup finishes, it postMessages us — refresh the list.
  useEffect(() => {
    function onMsg(e) {
      if (e.data?.type === 'mcp-oauth') {
        setTimeout(refresh, 600)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Begins OAuth: opens the provider login in a popup (or refreshes if already authorized).
  async function handleAuthorize(id) {
    setBusy(id)
    setError('')
    try {
      const res = await authorizeConnector(id)
      if (res.authUrl) {
        window.open(res.authUrl, 'mcp-oauth', 'width=520,height=720')
      } else if (res.authorized) {
        await refresh()
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function handleAdd() {
    if (!form.name.trim() || !form.url.trim()) {
      setFormError('Name and Remote MCP server URL are required.')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const created = await addConnector(form)
      setModalOpen(false)
      setForm(EMPTY_FORM)
      setShowAdvanced(false)
      await refresh()
      if (created.status === 'needs_auth') {
        // Server needs login — kick off OAuth right away (Claude-style).
        handleAuthorize(created.id)
      } else if (created.status === 'error') {
        setError(`Added "${created.name}", but couldn't connect: ${created.error}. Use Refresh after fixing the URL.`)
      }
    } catch (e) {
      setFormError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleRefresh(id) {
    setBusy(id)
    try {
      await refreshConnector(id)
      await refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }
  async function handleToggle(c) {
    setBusy(c.id)
    setConnectors((prev) => prev.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)))
    try {
      await setConnectorEnabled(c.id, !c.enabled)
    } catch (e) {
      setConnectors((prev) => prev.map((x) => (x.id === c.id ? { ...x, enabled: c.enabled } : x)))
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }
  async function handleRemove(id) {
    setBusy(id)
    try {
      await removeConnector(id)
      await refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  // Optimistically set a per-tool permission.
  async function handlePerm(connectorId, tool, perm) {
    setConnectors((prev) =>
      prev.map((c) => (c.id === connectorId ? { ...c, toolPerms: { ...c.toolPerms, [tool]: perm } } : c))
    )
    try {
      await setToolPermission(connectorId, tool, perm)
    } catch (e) {
      setError(e.message)
      refresh()
    }
  }

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-300">
            MCP connectors{' '}
            <span className="ml-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">
              beta
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Connect Claude to your tools via a remote Model Context Protocol server. Enabled tools are available in chat.
          </p>
        </div>
        <button
          onClick={() => {
            setForm(EMPTY_FORM)
            setFormError('')
            setShowAdvanced(false)
            setModalOpen(true)
          }}
          className="shrink-0 rounded-lg bg-nexus-accent px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
        >
          + Add custom connector
        </button>
      </div>

      {error && (
        <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      {loading ? (
        <div className="h-20 animate-pulse rounded-xl bg-white/5" />
      ) : connectors.length === 0 ? (
        <div className="rounded-xl border border-dashed border-nexus-border bg-nexus-panel/50 p-8 text-center text-sm text-gray-400">
          No MCP connectors yet. Add a remote MCP server URL (e.g. a hosted MCP service) to give Claude new tools.
        </div>
      ) : (
        <ul className="space-y-3">
          {connectors.map((c) => (
            <li key={c.id} className="rounded-xl border border-nexus-border bg-nexus-panel p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-medium text-gray-100">{c.name}</h3>
                    <StatusDot
                      connected={c.status === 'connected'}
                      on={`${c.toolCount} tool${c.toolCount === 1 ? '' : 's'}`}
                      off={c.status === 'needs_auth' ? 'Sign-in required' : c.status === 'error' ? 'Connection failed' : 'Unknown'}
                    />
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-gray-500">{c.url}</p>
                  {c.error && c.status !== 'needs_auth' && <p className="mt-1 text-xs text-red-400">{c.error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {c.status !== 'connected' && (
                    <button
                      onClick={() => handleAuthorize(c.id)}
                      disabled={busy === c.id}
                      className="rounded-lg bg-nexus-accent px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {busy === c.id ? '…' : 'Connect'}
                    </button>
                  )}
                  <Toggle on={c.enabled} disabled={busy === c.id} onClick={() => handleToggle(c)} />
                  <button
                    onClick={() => handleRefresh(c.id)}
                    disabled={busy === c.id}
                    className="rounded-lg px-2.5 py-1.5 text-sm text-gray-300 transition hover:bg-white/5 disabled:opacity-50"
                  >
                    {busy === c.id ? '…' : 'Refresh'}
                  </button>
                  <button
                    onClick={() => handleRemove(c.id)}
                    disabled={busy === c.id}
                    className="rounded-lg px-2.5 py-1.5 text-sm text-red-400 transition hover:bg-red-500/10 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </div>

              {c.toolCount > 0 && (
                <div className="mt-3">
                  <button
                    onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                    className="text-xs text-nexus-accent2 hover:underline"
                  >
                    {expanded === c.id ? 'Hide' : 'Show'} {c.toolCount} tool{c.toolCount === 1 ? '' : 's'}
                  </button>
                  {expanded === c.id && (
                    <div className="mt-2">
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                        Tool permissions
                      </p>
                      <p className="mb-2 text-xs text-gray-500">Choose when Nexus is allowed to use each tool.</p>
                      <ul className="space-y-1">
                        {c.tools.map((t) => (
                          <li key={t.name} className="flex items-center justify-between gap-3 rounded-lg bg-nexus-bg px-3 py-2 text-xs">
                            <div className="min-w-0">
                              <span className="font-mono text-gray-200">{t.name}</span>
                              {t.description && <span className="ml-2 truncate text-gray-500">{t.description}</span>}
                            </div>
                            <PermSelect
                              value={c.toolPerms?.[t.name] || 'allow'}
                              onChange={(perm) => handlePerm(c.id, t.name, perm)}
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Add custom connector modal */}
      <Modal
        open={modalOpen}
        onClose={() => !saving && setModalOpen(false)}
        title="Add custom connector"
        footer={
          <>
            <button
              onClick={() => setModalOpen(false)}
              disabled={saving}
              className="rounded-lg border border-nexus-border px-4 py-2 text-sm text-gray-300 transition hover:bg-white/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={saving}
              className="rounded-lg bg-nexus-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? 'Connecting…' : 'Add'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            Connect Nexus AI to your data and tools through a remote MCP server.
          </p>
          {formError && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{formError}</p>
          )}
          <Field
            label="Name"
            value={form.name}
            onChange={(v) => setForm((f) => ({ ...f, name: v }))}
            placeholder="e.g. My Notion"
          />
          <Field
            label="Remote MCP server URL"
            value={form.url}
            onChange={(v) => setForm((f) => ({ ...f, url: v }))}
            placeholder="https://mcp.example.com/mcp"
          />
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-xs text-gray-400 hover:text-gray-200"
          >
            {showAdvanced ? '▾' : '▸'} Advanced settings
          </button>
          {showAdvanced && (
            <div className="space-y-3 border-l border-nexus-border pl-3">
              <p className="text-xs text-gray-500">
                Some servers (e.g. Facebook, Google) require your own OAuth app instead of auto-registration.
                Create an app on the provider, paste its Client ID + Secret here, and register the redirect URI below.
              </p>
              {callbackUrl && (
                <div className="rounded-lg bg-nexus-bg p-2">
                  <p className="text-[10px] uppercase tracking-wide text-gray-500">Redirect URI to register with the provider</p>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="flex-1 truncate text-xs text-nexus-accent2">{callbackUrl}</code>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard?.writeText(callbackUrl)}
                      className="rounded border border-nexus-border px-2 py-0.5 text-[10px] text-gray-300 hover:bg-white/5"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              )}
              <Field
                label="OAuth Client ID (optional)"
                value={form.oauthClientId}
                onChange={(v) => setForm((f) => ({ ...f, oauthClientId: v }))}
                placeholder="provider app / client id"
              />
              <Field
                label="OAuth Client Secret / token (optional)"
                type="password"
                value={form.oauthSecret}
                onChange={(v) => setForm((f) => ({ ...f, oauthSecret: v }))}
                placeholder="app secret (OAuth), or a bearer token"
              />
            </div>
          )}
          <p className="text-xs text-gray-600">
            Only use connectors from developers you trust. Tools they expose run on your behalf.
          </p>
        </div>
      </Modal>
    </section>
  )
}

/* ----------------------- shared bits ----------------------- */

function Field({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-gray-300">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-nexus-border bg-nexus-bg px-3 py-2.5 text-sm text-gray-100 outline-none transition placeholder:text-gray-600 focus:border-nexus-accent"
      />
    </label>
  )
}

function PermSelect({ value, onChange }) {
  const styles = {
    allow: 'border-emerald-500/40 text-emerald-300',
    approval: 'border-amber-500/40 text-amber-300',
    blocked: 'border-red-500/40 text-red-300',
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`shrink-0 rounded-lg border bg-nexus-panel px-2 py-1 text-[11px] outline-none ${styles[value] || ''}`}
    >
      <option value="allow">Always allow</option>
      <option value="approval">Needs approval</option>
      <option value="blocked">Blocked</option>
    </select>
  )
}

function StatusDot({ connected, on, off }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        connected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-gray-500/10 text-gray-400',
      ].join(' ')}
    >
      <span className={['h-1.5 w-1.5 rounded-full', connected ? 'bg-emerald-400' : 'bg-gray-500'].join(' ')} />
      {connected ? on : off}
    </span>
  )
}

function Toggle({ on, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      title={on ? 'Enabled' : 'Disabled'}
      className={[
        'relative mr-1 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition disabled:opacity-50',
        on ? 'bg-nexus-accent' : 'bg-gray-600',
      ].join(' ')}
    >
      <span
        className={['inline-block h-4 w-4 transform rounded-full bg-white transition', on ? 'translate-x-4' : 'translate-x-0.5'].join(' ')}
      />
    </button>
  )
}
