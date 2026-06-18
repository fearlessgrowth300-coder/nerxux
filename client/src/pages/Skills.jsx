import { useEffect, useState } from 'react'
import PageShell from '../components/PageShell'
import Modal from '../components/Modal'
import { listSkills, createSkill, updateSkill, deleteSkill } from '../lib/skills'

const EMPTY = { name: '', description: '', content: '', enabled: true }

export default function Skills() {
  const [skills, setSkills] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Editor modal state: `editing` is null (closed), 'new', or a skill object.
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  // Delete confirm + per-row busy state.
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [busyId, setBusyId] = useState(null)

  async function refresh() {
    setLoading(true)
    setError('')
    try {
      setSkills(await listSkills())
    } catch (e) {
      setError(e.message || 'Failed to load skills.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  function openNew() {
    setForm(EMPTY)
    setFormError('')
    setEditing('new')
  }
  function openEdit(skill) {
    setForm({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      enabled: skill.enabled,
    })
    setFormError('')
    setEditing(skill)
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setFormError('Name is required.')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      if (editing === 'new') {
        await createSkill(form)
      } else {
        await updateSkill(editing.id, form)
      }
      setEditing(null)
      await refresh()
    } catch (e) {
      setFormError(e.message || 'Failed to save skill.')
    } finally {
      setSaving(false)
    }
  }

  // Optimistic enable/disable toggle with rollback on error.
  async function handleToggle(skill) {
    setBusyId(skill.id)
    setSkills((prev) =>
      prev.map((s) => (s.id === skill.id ? { ...s, enabled: !s.enabled } : s))
    )
    try {
      await updateSkill(skill.id, { enabled: !skill.enabled })
    } catch (e) {
      // rollback
      setSkills((prev) =>
        prev.map((s) => (s.id === skill.id ? { ...s, enabled: skill.enabled } : s))
      )
      setError(e.message || 'Failed to update skill.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete() {
    const skill = confirmDelete
    setBusyId(skill.id)
    try {
      await deleteSkill(skill.id)
      setConfirmDelete(null)
      await refresh()
    } catch (e) {
      setError(e.message || 'Failed to delete skill.')
    } finally {
      setBusyId(null)
    }
  }

  const enabledCount = skills.filter((s) => s.enabled).length

  return (
    <PageShell
      title="Skills"
      description={`Reusable prompt modules. ${enabledCount} enabled skill${enabledCount === 1 ? ' is' : 's are'} appended to your system prompt.`}
      actions={
        <button
          onClick={openNew}
          className="rounded-lg bg-nexus-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
        >
          + New skill
        </button>
      }
    >
      {error && (
        <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-white/5" />
          ))}
        </div>
      ) : skills.length === 0 ? (
        <div className="rounded-xl border border-dashed border-nexus-border bg-nexus-panel/50 p-10 text-center">
          <p className="text-gray-300">No skills yet.</p>
          <p className="mt-1 text-sm text-gray-500">
            Create reusable instructions you can toggle on per need.
          </p>
          <button
            onClick={openNew}
            className="mt-4 rounded-lg bg-nexus-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
          >
            Create your first skill
          </button>
        </div>
      ) : (
        <ul className="space-y-3">
          {skills.map((skill) => (
            <li
              key={skill.id}
              className="flex items-start justify-between gap-4 rounded-xl border border-nexus-border bg-nexus-panel p-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="truncate font-medium text-gray-100">
                    {skill.name}
                  </h3>
                  {!skill.enabled && (
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">
                      off
                    </span>
                  )}
                </div>
                {skill.description && (
                  <p className="mt-0.5 truncate text-sm text-gray-400">
                    {skill.description}
                  </p>
                )}
                <p className="mt-1 line-clamp-2 text-xs text-gray-600">
                  {skill.content || 'No content'}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <Toggle
                  on={skill.enabled}
                  disabled={busyId === skill.id}
                  onClick={() => handleToggle(skill)}
                />
                <button
                  onClick={() => openEdit(skill)}
                  className="rounded-lg px-3 py-1.5 text-sm text-gray-300 transition hover:bg-white/5"
                >
                  Edit
                </button>
                <button
                  onClick={() => setConfirmDelete(skill)}
                  className="rounded-lg px-3 py-1.5 text-sm text-red-400 transition hover:bg-red-500/10"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Create / edit modal */}
      <Modal
        open={editing !== null}
        onClose={() => !saving && setEditing(null)}
        title={editing === 'new' ? 'New skill' : 'Edit skill'}
        footer={
          <>
            <button
              onClick={() => setEditing(null)}
              disabled={saving}
              className="rounded-lg border border-nexus-border px-4 py-2 text-sm text-gray-300 transition hover:bg-white/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg bg-nexus-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save skill'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {formError && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {formError}
            </p>
          )}
          <LabeledInput
            label="Name"
            value={form.name}
            onChange={(v) => setForm((f) => ({ ...f, name: v }))}
            placeholder="e.g. Ad Copywriter"
          />
          <LabeledInput
            label="Description"
            value={form.description}
            onChange={(v) => setForm((f) => ({ ...f, description: v }))}
            placeholder="Short summary (optional)"
          />
          <label className="block">
            <span className="mb-1 block text-sm text-gray-300">
              Content (injected into the system prompt)
            </span>
            <textarea
              value={form.content}
              onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
              placeholder="Write the instructions this skill adds…"
              className="h-40 w-full resize-y rounded-lg border border-nexus-border bg-nexus-bg p-3 font-mono text-sm text-gray-100 outline-none transition placeholder:text-gray-600 focus:border-nexus-accent"
              spellCheck={false}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
              className="h-4 w-4 rounded border-nexus-border bg-nexus-bg accent-nexus-accent"
            />
            Enabled (appended to system prompt)
          </label>
        </div>
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={confirmDelete !== null}
        onClose={() => busyId === null && setConfirmDelete(null)}
        title="Delete skill?"
        footer={
          <>
            <button
              onClick={() => setConfirmDelete(null)}
              disabled={busyId !== null}
              className="rounded-lg border border-nexus-border px-4 py-2 text-sm text-gray-300 transition hover:bg-white/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={busyId !== null}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-500 disabled:opacity-50"
            >
              {busyId !== null ? 'Deleting…' : 'Delete'}
            </button>
          </>
        }
      >
        <p className="text-sm text-gray-300">
          This permanently deletes{' '}
          <span className="font-medium text-gray-100">{confirmDelete?.name}</span>.
          This can't be undone.
        </p>
      </Modal>
    </PageShell>
  )
}

// ---- small presentational helpers ----

function LabeledInput({ label, value, onChange, placeholder }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-gray-300">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-nexus-border bg-nexus-bg px-3 py-2.5 text-gray-100 outline-none transition placeholder:text-gray-600 focus:border-nexus-accent"
      />
    </label>
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
        className={[
          'inline-block h-4 w-4 transform rounded-full bg-white transition',
          on ? 'translate-x-4' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  )
}
