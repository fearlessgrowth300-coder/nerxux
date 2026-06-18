import { CHAT_MODELS } from '@shared/models'

// Model A / Model B selectors + Pipeline toggle for the chat header.
// - Model A is always required.
// - Model B may be "None" (single-model mode).
// - The Pipeline toggle is only enabled when both A and B are selected.
export default function ModelControls({
  modelA,
  modelB,
  pipeline,
  onChangeA,
  onChangeB,
  onTogglePipeline,
}) {
  const bothSelected = Boolean(modelA && modelB)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        label="A"
        value={modelA}
        onChange={onChangeA}
        options={CHAT_MODELS}
      />

      <span className="text-xs text-gray-600">→</span>

      <Select
        label="B"
        value={modelB || ''}
        onChange={(v) => onChangeB(v || null)}
        options={CHAT_MODELS}
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
