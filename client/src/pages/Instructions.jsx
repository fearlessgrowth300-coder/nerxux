import { useEffect, useRef, useState } from 'react'
import PageShell from '../components/PageShell'
import { getInstructions, saveInstructions } from '../lib/instructions'

// Global system-prompt editor. Loads the saved value on mount, lets the user
// edit, and persists to Supabase. Tracks dirty state so the Save button and
// status reflect reality (loading / saving / saved / error / unsaved changes).
export default function Instructions() {
  const [value, setValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedAt, setSavedAt] = useState(null)
  const savedValueRef = useRef('') // last value known to be persisted

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const content = await getInstructions()
        if (!mounted) return
        setValue(content)
        savedValueRef.current = content
      } catch (e) {
        if (mounted) setError(e.message || 'Failed to load instructions.')
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  const dirty = value !== savedValueRef.current

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      await saveInstructions(value)
      savedValueRef.current = value
      setSavedAt(new Date())
    } catch (e) {
      setError(e.message || 'Failed to save. Did you run the schema SQL?')
    } finally {
      setSaving(false)
    }
  }

  return (
    <PageShell
      title="Instructions"
      description="Your global system prompt. It's prepended to every AI request as the system message."
      actions={
        <button
          onClick={handleSave}
          disabled={saving || loading || !dirty}
          className="rounded-lg bg-nexus-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
      }
    >
      {error && (
        <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      )}

      <div className="rounded-xl border border-nexus-border bg-nexus-panel p-4">
        {loading ? (
          <div className="h-64 animate-pulse rounded-lg bg-white/5" />
        ) : (
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. You are a concise, expert assistant. Always respond in markdown. Prefer examples over theory…"
            className="h-72 w-full resize-y rounded-lg border border-nexus-border bg-nexus-bg p-4 font-mono text-sm leading-relaxed text-gray-100 outline-none transition placeholder:text-gray-600 focus:border-nexus-accent"
            spellCheck={false}
          />
        )}

        <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
          <span>{value.length} characters</span>
          <span>
            {dirty
              ? 'Unsaved changes'
              : savedAt
                ? `Saved ${savedAt.toLocaleTimeString()}`
                : 'Up to date'}
          </span>
        </div>
      </div>

      <p className="mt-4 text-xs text-gray-500">
        Tip: keep this focused on durable preferences (tone, format, role).
        Task-specific context belongs in Skills.
      </p>
    </PageShell>
  )
}
