import { useEffect, useState } from 'react'
import { CHAT_MODELS } from '@shared/models'
import { getConnections } from '../lib/connections'

// Local providers need no API key — always selectable.
const NO_KEY_PROVIDERS = new Set(['nexus', 'ollama'])

// Returns the chat models whose provider is actually usable (a connected key,
// a platform key, or a no-key local model). Falls back to every model if the
// connection lookup fails, so chat never ends up with an empty dropdown.
function useAvailableModels(modelA, modelB, onChangeA, onChangeB) {
  const [models, setModels] = useState(CHAT_MODELS)

  useEffect(() => {
    let alive = true
    getConnections()
      .then((conns) => {
        if (!alive) return
        const usable = new Set(conns.map((c) => c.provider))
        const available = CHAT_MODELS.filter(
          (m) => NO_KEY_PROVIDERS.has(m.provider) || usable.has(m.provider)
        )
        setModels(available.length ? available : CHAT_MODELS)
      })
      .catch(() => alive && setModels(CHAT_MODELS))
    return () => {
      alive = false
    }
  }, [])

  // If the current selection points at a model that's no longer available,
  // snap A to the first available model and clear a stale B.
  useEffect(() => {
    if (!models.length) return
    if (modelA && !models.some((m) => m.id === modelA)) onChangeA(models[0].id)
    if (modelB && !models.some((m) => m.id === modelB)) onChangeB(null)
  }, [models, modelA, modelB, onChangeA, onChangeB])

  return models
}

// Model A / Model B selectors + Pipeline toggle for the chat header.
// - Model A is always required.
// - Model B may be "None" (single-model mode).
// - The Pipeline toggle is only enabled when both A and B are selected.
// - Only models from connected providers are listed (see useAvailableModels).
export default function ModelControls({
  modelA,
  modelB,
  pipeline,
  onChangeA,
  onChangeB,
  onTogglePipeline,
}) {
  const bothSelected = Boolean(modelA && modelB)
  const models = useAvailableModels(modelA, modelB, onChangeA, onChangeB)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        label="A"
        value={modelA}
        onChange={onChangeA}
        options={models}
      />

      <span className="text-xs text-gray-600">→</span>

      <Select
        label="B"
        value={modelB || ''}
        onChange={(v) => onChangeB(v || null)}
        options={models}
        allowNone
      />

      <button
        type="button"
        onClick={onTogglePipeline}
        disabled={!bothSelected}
        title={
          bothSelected
            ? 'Pipeline: Model A (analyst) → Model B (executor)'
            : 'Select two models to enable pipeline'
        }
        className={[
          'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition',
          !bothSelected
            ? 'cursor-not-allowed border-nexus-border text-gray-600'
            : pipeline
              ? 'border-nexus-accent bg-nexus-accent/15 text-nexus-accent2'
              : 'border-nexus-border text-gray-300 hover:bg-white/5',
        ].join(' ')}
      >
        <span
          className={[
            'relative inline-flex h-3.5 w-6 items-center rounded-full transition',
            pipeline && bothSelected ? 'bg-nexus-accent' : 'bg-gray-600',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block h-2.5 w-2.5 transform rounded-full bg-white transition',
              pipeline && bothSelected ? 'translate-x-3' : 'translate-x-0.5',
            ].join(' ')}
          />
        </span>
        Pipeline
      </button>
    </div>
  )
}

function Select({ label, value, onChange, options, allowNone }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-nexus-border bg-nexus-bg px-2 py-1.5 text-xs text-gray-100 outline-none transition focus:border-nexus-accent"
      >
        {allowNone && <option value="">None</option>}
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  )
}
