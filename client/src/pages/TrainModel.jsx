import { useEffect, useRef, useState } from 'react'
import PageShell from '../components/PageShell'
import { FileIcon } from '../components/icons'
import {
  uploadTrainingFiles,
  deleteTrainingFile,
  getTrainingStatus,
  getTrainingLogs,
  buildCorpus,
  startTraining,
  stopTraining,
} from '../lib/training'
import { getInstructions, saveInstructions } from '../lib/instructions'
import { listNotes, createNote, updateNote } from '../lib/notes'
import { extractPdfText } from '../lib/pdf'

function fmtBytes(n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`
}

// "Teach your AI" — the part that actually steers the API models (Claude, GPT-4o,
// Groq, …). Instructions are saved as the global system prompt; uploaded docs
// become AI-knowledge notes. Both feed buildSystemPrompt(), so EVERY model you
// pick in chat obeys these — no model training involved.
function TeachAI() {
  const [instructions, setInstructions] = useState('')
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [savingInstr, setSavingInstr] = useState(false)
  const [savedInstr, setSavedInstr] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const docRef = useRef(null)

  async function refresh() {
    setLoading(true)
    try {
      const instr = await getInstructions()
      setInstructions(instr || '')
      // Notes table is optional — if it hasn't been created in Supabase yet,
      // keep the instructions half working and surface a clear hint.
      try {
        const notes = await listNotes()
        setDocs((notes || []).filter((n) => n.in_context))
      } catch (e) {
        if (/notes/i.test(e.message) && /schema|not find|exist/i.test(e.message)) {
          setError("Knowledge files need the 'notes' table — run supabase/schema.sql in your Supabase SQL editor (see below). Instructions work without it.")
        } else {
          setError(e.message)
        }
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() }, [])

  async function onSaveInstructions() {
    setSavingInstr(true); setError(''); setSavedInstr(false)
    try {
      await saveInstructions(instructions)
      setSavedInstr(true)
      setTimeout(() => setSavedInstr(false), 2000)
    } catch (e) {
      setError(e.message)
    } finally {
      setSavingInstr(false)
    }
  }

  async function onUploadDocs(e) {
    const files = [...(e.target.files || [])]
    if (!files.length) return
    setImporting(true); setError('')
    try {
      for (const file of files) {
        const isPdf = /\.pdf$/i.test(file.name)
        const text = isPdf ? await extractPdfText(file) : await file.text()
        if (!text.trim()) continue
        const title = file.name.replace(/\.(pdf|txt|md)$/i, '')
        const n = await createNote({ title, content: text })
        await updateNote(n.id, { in_context: true }) // used as AI knowledge
      }
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
      if (docRef.current) docRef.current.value = ''
    }
  }

  // Stop steering the AI with this doc (keeps the note itself in Notes).
  async function onRemoveDoc(id) {
    try {
      await updateNote(id, { in_context: false })
      setDocs((d) => d.filter((x) => x.id !== id))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <section className="mb-8 rounded-xl border border-nexus-accent/40 bg-nexus-accent/5 p-5">
      <h2 className="text-base font-semibold text-gray-100">Teach your AI</h2>
      <p className="mt-1 text-sm text-gray-400">
        This controls <strong>every API model you connect</strong> — Claude, GPT-4o, Groq, all of them. Your
        instructions become rules they always follow, and uploaded files become knowledge they always use.
        No model training — it works instantly with whatever key you pick in chat.
      </p>
      {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>}

      <div className="mt-4 grid gap-5 lg:grid-cols-2">
        {/* Instructions */}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-200">Instructions your AI follows</label>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={loading}
            rows={8}
            placeholder={'e.g. You are my marketing assistant. Always write in a friendly, punchy tone. When I ask for ads, give 3 variations and a CTA. Never use emojis in ad copy.'}
            className="w-full resize-y rounded-lg border border-nexus-border bg-nexus-bg px-3 py-2.5 text-sm text-gray-100 outline-none transition placeholder:text-gray-600 focus:border-nexus-accent"
          />
          <button
            onClick={onSaveInstructions}
            disabled={savingInstr || loading}
            className="mt-2 rounded-lg bg-nexus-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {savingInstr ? 'Saving…' : savedInstr ? 'Saved ✓' : 'Save instructions'}
          </button>
        </div>

        {/* Knowledge docs */}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-200">Knowledge files your AI uses</label>
          <button
            onClick={() => docRef.current?.click()}
            disabled={importing}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-nexus-border py-5 text-sm text-gray-400 transition hover:border-nexus-accent hover:text-gray-200 disabled:opacity-50"
          >
            <FileIcon className="h-5 w-5" />
            {importing ? 'Reading…' : 'Upload PDF / TXT / MD as knowledge'}
          </button>
          <input ref={docRef} type="file" multiple accept=".pdf,.txt,.md" onChange={onUploadDocs} className="hidden" />

          <div className="mt-3 max-h-40 space-y-1 overflow-auto">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 text-xs">
                <span className="truncate text-gray-300">{d.title}</span>
                <button onClick={() => onRemoveDoc(d.id)} title="Stop using as AI knowledge"
                  className="text-gray-500 hover:text-red-400">✕</button>
              </div>
            ))}
            {!loading && !docs.length && (
              <p className="px-1 py-2 text-xs text-gray-600">No knowledge files yet. Upload a product sheet, brand guide, FAQ…</p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

// Train-your-own-model console: upload source text/PDFs, build the corpus, run
// training, and watch the loss fall in the live log. Calls the nexus-model
// engine through /api/training/*.
export default function TrainModel() {
  const [status, setStatus] = useState(null)
  const [log, setLog] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [steps, setSteps] = useState(2000)
  const [size, setSize] = useState('small')
  const fileRef = useRef(null)
  const logRef = useRef(null)

  const SIZES = {
    tiny: { n_layer: 2, n_head: 2, n_embd: 64, block: 32, vocab: 1024 },
    small: { n_layer: 4, n_head: 4, n_embd: 128, block: 64, vocab: 2048 },
    medium: { n_layer: 6, n_head: 6, n_embd: 192, block: 96, vocab: 4096 },
  }

  async function refresh() {
    try {
      const [s, l] = await Promise.all([getTrainingStatus(), getTrainingLogs()])
      setStatus(s)
      setLog(l.log || [])
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const running = status?.job?.running
  const health = status?.health

  async function onUpload(e) {
    const files = e.target.files
    if (!files?.length) return
    setBusy(true); setError('')
    try {
      await uploadTrainingFiles(files)
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function onDelete(name) {
    try { await deleteTrainingFile(name); await refresh() } catch (e) { setError(e.message) }
  }

  async function run(fn) {
    setBusy(true); setError('')
    try { await fn(); await refresh() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <PageShell
      title="Train & teach"
      description="Teach any AI you connect (Claude / GPT-4o / Groq) with instructions + knowledge files — or, separately, train the tiny experimental model from scratch."
    >
      <TeachAI />

      <div className="mb-5 border-t border-nexus-border pt-6">
        <h2 className="text-base font-semibold text-gray-100">Build a from-scratch model (advanced / experimental)</h2>
        <p className="mt-1 text-sm text-gray-400">
          This trains a tiny transformer on your machine from zero. It’s a real engine but small by design —
          it does <strong>not</strong> affect your API models above, and its output is rough. For actually
          steering your AI, use “Teach your AI” above.
        </p>
      </div>

      {error && (
        <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      {/* Model server health */}
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-nexus-border bg-nexus-panel p-4 text-sm">
        <span className={`h-2.5 w-2.5 rounded-full ${health?.reachable ? (health?.loaded ? 'bg-green-400' : 'bg-yellow-400') : 'bg-red-500'}`} />
        <span className="text-gray-300">
          {!health?.reachable
            ? 'Model server offline — run: cd nexus-model && python serve.py'
            : health?.loaded
              ? `Your model is live (${health.params?.toLocaleString()} parameters)`
              : 'Model server up, but no trained weights yet — train below.'}
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Left: data */}
        <div className="space-y-5">
          <div className="rounded-xl border border-nexus-border bg-nexus-panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-medium text-gray-200">1. Training data</h3>
              <span className="text-xs text-gray-500">{status?.uploads?.length || 0} files</span>
            </div>

            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-nexus-border py-6 text-sm text-gray-400 transition hover:border-nexus-accent hover:text-gray-200 disabled:opacity-50"
            >
              <FileIcon className="h-5 w-5" />
              Click to upload PDF / TXT / HTML / EPUB
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.txt,.md,.html,.htm,.epub"
              onChange={onUpload}
              className="hidden"
            />

            <div className="mt-3 max-h-44 space-y-1 overflow-auto">
              {(status?.uploads || []).map((f) => (
                <div key={f.name} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 text-xs">
                  <span className="truncate text-gray-300">{f.name}</span>
                  <span className="flex items-center gap-3">
                    <span className="text-gray-500">{fmtBytes(f.sizeBytes)}</span>
                    <button onClick={() => onDelete(f.name)} className="text-gray-500 hover:text-red-400">✕</button>
                  </span>
                </div>
              ))}
              {!status?.uploads?.length && (
                <p className="px-1 py-2 text-xs text-gray-600">No files yet. Add some text to learn from.</p>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-nexus-border bg-nexus-panel p-4">
            <h3 className="mb-2 font-medium text-gray-200">2. Build corpus</h3>
            <p className="mb-3 text-xs text-gray-500">
              Extract text, clean it (regex / filters), and remove near-duplicates (MinHash) into one corpus.
              {status?.corpusBytes ? ` Current corpus: ${fmtBytes(status.corpusBytes)}.` : ' No corpus built yet.'}
            </p>
            <button
              onClick={() => run(buildCorpus)}
              disabled={busy || running}
              className="rounded-lg bg-white/10 px-4 py-2 text-sm text-gray-100 transition hover:bg-white/20 disabled:opacity-50"
            >
              {running && status?.job?.kind === 'build' ? 'Building…' : 'Build corpus'}
            </button>
          </div>
        </div>

        {/* Right: train */}
        <div className="space-y-5">
          <div className="rounded-xl border border-nexus-border bg-nexus-panel p-4">
            <h3 className="mb-3 font-medium text-gray-200">3. Train</h3>

            <label className="mb-1 block text-xs text-gray-400">Model size</label>
            <select
              value={size}
              onChange={(e) => setSize(e.target.value)}
              disabled={running}
              className="mb-3 w-full rounded-lg border border-nexus-border bg-nexus-bg px-3 py-2 text-sm text-gray-100 outline-none focus:border-nexus-accent"
            >
              <option value="tiny">Tiny — fastest, ~0.1M params</option>
              <option value="small">Small — balanced, ~1M params</option>
              <option value="medium">Medium — slower, sharper</option>
            </select>

            <label className="mb-1 block text-xs text-gray-400">Training steps: {steps}</label>
            <input
              type="range" min="200" max="10000" step="200"
              value={steps}
              onChange={(e) => setSteps(Number(e.target.value))}
              disabled={running}
              className="mb-4 w-full accent-nexus-accent"
            />

            {!running ? (
              <button
                onClick={() => run(() => startTraining({ steps, ...SIZES[size] }))}
                disabled={busy}
                className="w-full rounded-lg bg-nexus-accent px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
              >
                Start training
              </button>
            ) : (
              <button
                onClick={() => run(stopTraining)}
                className="w-full rounded-lg bg-red-500/80 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-red-500"
              >
                Stop {status?.job?.kind}
              </button>
            )}
          </div>

          <div className="rounded-xl border border-nexus-border bg-nexus-panel p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-medium text-gray-200">Live log</h3>
              {running && <span className="text-xs text-nexus-accent">● {status?.job?.kind} running</span>}
            </div>
            <div
              ref={logRef}
              className="h-64 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-gray-300"
            >
              {log.length ? log.map((l, i) => <div key={i} className="whitespace-pre-wrap">{l}</div>)
                : <span className="text-gray-600">Logs from build / training appear here.</span>}
            </div>
          </div>
        </div>
      </div>

      <p className="mt-5 text-xs text-gray-500">
        This trains a real transformer from scratch on your machine via gradient descent. It’s small by
        design (one machine, not a datacenter) — more data + more steps = better output. Once trained,
        start the model server and pick <strong>Nexus (your model)</strong> in Chat.
      </p>
    </PageShell>
  )
}
