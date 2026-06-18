import { useEffect, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import Markdown from '../components/Markdown'
import ModelControls from '../components/ModelControls'
import { PaperclipIcon } from '../components/icons'
import { useAuth } from '../context/AuthContext'
import { sendChat } from '../lib/chat'
import { uploadVideo, analysisToContext } from '../lib/upload'
import { buildSystemPrompt } from '../lib/systemPrompt'
import { listSkills } from '../lib/skills'
import { getModelById } from '@shared/models'

// Starter prompts for the welcome-screen suggestion chips.
const CHIPS = [
  { label: 'Code', icon: '⌨️', text: 'Help me write code that ' },
  { label: 'Learn', icon: '📚', text: 'Explain how ' },
  { label: 'Create', icon: '✦', text: 'Create ' },
  { label: 'Write', icon: '✎', text: 'Write ' },
]

function firstName(email = '') {
  const n = (email.split('@')[0] || 'there').replace(/[._-]+/g, ' ')
  return n.charAt(0).toUpperCase() + n.slice(1)
}

export default function Chat() {
  const { user } = useAuth()
  const storageKey = `nexus.chat.${user?.id || 'anon'}`
  const settingsKey = `nexus.chatModels.${user?.id || 'anon'}`

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const [modelA, setModelA] = useState('claude-sonnet')
  const [modelB, setModelB] = useState(null)
  const [pipeline, setPipeline] = useState(false)
  const [auto, setAuto] = useState(false)

  const [uploading, setUploading] = useState(false)
  const [pendingVideo, setPendingVideo] = useState(null)

  // Skills (for the "/" slash menu).
  const [skills, setSkills] = useState([])

  const scrollRef = useRef(null)
  const fileInputRef = useRef(null)
  const taRef = useRef(null)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      setMessages(saved ? JSON.parse(saved) : [])
    } catch {
      setMessages([])
    }
    try {
      const s = JSON.parse(localStorage.getItem(settingsKey) || '{}')
      if (s.modelA) setModelA(s.modelA)
      setModelB(s.modelB ?? null)
      setPipeline(Boolean(s.pipeline))
      setAuto(Boolean(s.auto))
    } catch {}
    listSkills().then(setSkills).catch(() => {})
  }, [storageKey, settingsKey])

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(messages))
    } catch {}
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending, storageKey])

  useEffect(() => {
    try {
      localStorage.setItem(settingsKey, JSON.stringify({ modelA, modelB, pipeline, auto }))
    } catch {}
  }, [modelA, modelB, pipeline, auto, settingsKey])

  const pipelineActive = Boolean(modelA && modelB && pipeline)
  const isEmpty = messages.length === 0 && !sending

  async function handleSend() {
    const text = input.trim()
    if (!text || sending) return

    setError('')
    const userMsg = { id: uuid(), role: 'user', content: text }
    const history = [...messages, userMsg]
    setMessages(history)
    setInput('')
    setSending(true)

    const videoContext = pendingVideo ? analysisToContext(pendingVideo.analysis) : null
    setPendingVideo(null)

    try {
      const systemPrompt = await buildSystemPrompt()
      const { messages: replies, routing } = await sendChat({
        history: history.map(({ role, content }) => ({ role, content })),
        modelA,
        modelB,
        pipeline,
        systemPrompt,
        videoContext,
        auto,
      })
      const toAdd = []
      if (routing) toAdd.push({ id: uuid(), role: 'routing', routing })
      for (const r of replies) toAdd.push({ id: uuid(), ...r })
      setMessages((prev) => [...prev, ...toAdd])
    } catch (e) {
      setError(e.message)
      setMessages((prev) => [
        ...prev,
        { id: uuid(), role: 'assistant', content: `⚠️ ${e.message}`, model: modelA, error: true },
      ])
    } finally {
      setSending(false)
    }
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError('')
    setUploading(true)
    try {
      const { filename, source, analysis } = await uploadVideo(file)
      setPendingVideo({ filename, analysis })
      setMessages((prev) => [...prev, { id: uuid(), role: 'video', filename, source, analysis }])
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  function clearChat() {
    setMessages([])
    setError('')
    setPendingVideo(null)
  }

  const composer = (
    <Composer
      input={input}
      setInput={setInput}
      onSend={handleSend}
      sending={sending}
      uploading={uploading}
      onUploadClick={() => fileInputRef.current?.click()}
      skills={skills}
      taRef={taRef}
    />
  )

  return (
    <div className="flex h-full flex-col">
      {/* Header with model controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nexus-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <AutoToggle auto={auto} setAuto={setAuto} />
          {auto ? (
            <span className="text-xs text-gray-500">The intent router picks the tools for each message.</span>
          ) : (
            <ModelControls
              modelA={modelA}
              modelB={modelB}
              pipeline={pipeline}
              onChangeA={setModelA}
              onChangeB={setModelB}
              onTogglePipeline={() => setPipeline((v) => !v)}
            />
          )}
        </div>
        <button
          onClick={clearChat}
          disabled={messages.length === 0 || sending}
          className="rounded-lg px-3 py-1.5 text-sm text-gray-400 transition hover:bg-white/5 hover:text-gray-200 disabled:opacity-40"
        >
          Clear chat
        </button>
      </div>

      {/* Hidden file input (shared) */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
        onChange={handleFile}
        className="hidden"
      />

      {isEmpty ? (
        /* ---------- Welcome screen (Claude-style) ---------- */
        <div className="flex flex-1 flex-col items-center justify-center px-4">
          <div className="w-full max-w-2xl">
            <h1 className="mb-8 text-center text-3xl font-semibold text-gray-100">
              <span className="bg-gradient-to-r from-nexus-accent to-nexus-accent2 bg-clip-text text-transparent">
                ✦
              </span>{' '}
              Welcome, {firstName(user?.email)}
            </h1>
            {error && <p className="mb-3 text-center text-xs text-red-400">{error}</p>}
            {composer}
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {CHIPS.map((c) => (
                <button
                  key={c.label}
                  onClick={() => {
                    setInput(c.text)
                    taRef.current?.focus()
                  }}
                  className="flex items-center gap-1.5 rounded-full border border-nexus-border bg-nexus-panel px-3 py-1.5 text-sm text-gray-300 transition hover:bg-white/5"
                >
                  <span>{c.icon}</span>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        /* ---------- Active conversation ---------- */
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto w-full max-w-3xl space-y-5">
              {messages.map((m) =>
                m.role === 'video' ? (
                  <VideoAnalysisCard key={m.id} message={m} />
                ) : m.role === 'routing' ? (
                  <RoutingCard key={m.id} routing={m.routing} />
                ) : (
                  <Message key={m.id} message={m} />
                )
              )}
              {sending && (
                <TypingIndicator
                  label={
                    pipelineActive
                      ? `${getModelById(modelA)?.label} → ${getModelById(modelB)?.label}`
                      : getModelById(modelA)?.label
                  }
                />
              )}
            </div>
          </div>

          <div className="border-t border-nexus-border px-4 py-3">
            <div className="mx-auto w-full max-w-3xl">
              {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
              {pipelineActive && (
                <p className="mb-2 text-xs text-nexus-accent2">
                  Pipeline mode on — {getModelById(modelA)?.label} analyzes, then {getModelById(modelB)?.label} executes.
                </p>
              )}
              {pendingVideo && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-nexus-accent/10 px-3 py-1.5 text-xs text-nexus-accent2">
                  <span className="truncate">📹 {pendingVideo.filename} — injected into your next message</span>
                  <button onClick={() => setPendingVideo(null)} className="text-gray-400 hover:text-gray-200">✕</button>
                </div>
              )}
              {composer}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ---------------- Composer (shared, with "/" skills menu) ---------------- */

function Composer({ input, setInput, onSend, sending, uploading, onUploadClick, skills, taRef }) {
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')

  function onChange(e) {
    const v = e.target.value
    setInput(v)
    // Open the skills menu when a "/" begins a token at the end of the input.
    const m = /(?:^|\s)\/([\w-]*)$/.exec(v)
    if (m) {
      setSlashOpen(true)
      setSlashQuery(m[1].toLowerCase())
    } else {
      setSlashOpen(false)
    }
  }

  function insertSkill(skill) {
    // Replace the trailing "/query" with a reference to the skill.
    setInput((prev) => prev.replace(/(?:^|\s)\/[\w-]*$/, (match) => {
      const lead = match.startsWith(' ') ? ' ' : ''
      return `${lead}[skill: ${skill.name}] `
    }))
    setSlashOpen(false)
    taRef.current?.focus()
  }

  function onKeyDown(e) {
    if (slashOpen && e.key === 'Escape') {
      setSlashOpen(false)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !slashOpen) {
      e.preventDefault()
      onSend()
    }
  }

  const filtered = skills.filter((s) => s.name.toLowerCase().includes(slashQuery))

  return (
    <div className="relative">
      {slashOpen && filtered.length > 0 && (
        <div className="absolute bottom-full mb-2 max-h-56 w-full overflow-y-auto rounded-xl border border-nexus-border bg-nexus-panel p-1 shadow-2xl">
          <p className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-gray-500">Skills</p>
          {filtered.map((s) => (
            <button
              key={s.id}
              onClick={() => insertSkill(s)}
              className="flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition hover:bg-white/5"
            >
              <span className="text-sm text-gray-200">
                {s.name}
                {!s.enabled && <span className="ml-2 text-[10px] text-gray-600">(off)</span>}
              </span>
              {s.description && <span className="truncate text-xs text-gray-500">{s.description}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-2xl border border-nexus-border bg-nexus-panel p-2 shadow-lg">
        <button
          onClick={onUploadClick}
          disabled={uploading || sending}
          title="Upload a video (.mp4, .mov, .webm) for analysis"
          className="rounded-xl p-2 text-gray-400 transition hover:bg-white/5 hover:text-gray-200 disabled:opacity-50"
        >
          {uploading ? (
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-nexus-accent2" />
          ) : (
            <PaperclipIcon className="h-5 w-5" />
          )}
        </button>
        <textarea
          ref={taRef}
          rows={1}
          value={input}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder="Type / for skills, or ask anything…  (Enter to send, Shift+Enter for newline)"
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-gray-100 outline-none placeholder:text-gray-600"
        />
        <button
          onClick={onSend}
          disabled={!input.trim() || sending}
          className="rounded-xl bg-nexus-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

/* ---------------- subcomponents ---------------- */

function AutoToggle({ auto, setAuto }) {
  return (
    <button
      type="button"
      onClick={() => setAuto((v) => !v)}
      title="Auto-route: the intent router picks the tools for each message"
      className={[
        'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition',
        auto ? 'border-nexus-accent bg-nexus-accent/15 text-nexus-accent2' : 'border-nexus-border text-gray-300 hover:bg-white/5',
      ].join(' ')}
    >
      <span className={['relative inline-flex h-3.5 w-6 items-center rounded-full transition', auto ? 'bg-nexus-accent' : 'bg-gray-600'].join(' ')}>
        <span className={['inline-block h-2.5 w-2.5 transform rounded-full bg-white transition', auto ? 'translate-x-3' : 'translate-x-0.5'].join(' ')} />
      </span>
      Auto-route
    </button>
  )
}

function StageBadge({ stage }) {
  if (!stage) return null
  const map = { analyst: 'bg-amber-500/15 text-amber-300', executor: 'bg-emerald-500/15 text-emerald-300' }
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${map[stage] || ''}`}>{stage}</span>
}

function Message({ message }) {
  const isUser = message.role === 'user'
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div className={isUser ? 'max-w-[85%]' : 'w-full max-w-[85%]'}>
        {!isUser && (
          <div className="mb-1 flex items-center gap-2">
            <span
              className={[
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                message.error ? 'bg-red-500/10 text-red-400' : 'bg-nexus-accent/15 text-nexus-accent2',
              ].join(' ')}
            >
              {getModelById(message.model)?.label || message.modelLabel || 'Assistant'}
            </span>
            <StageBadge stage={message.stage} />
          </div>
        )}
        <div
          className={[
            'rounded-2xl px-4 py-3',
            isUser ? 'bg-nexus-accent text-white' : 'border border-nexus-border bg-nexus-panel',
          ].join(' ')}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap text-sm">{message.content}</p>
          ) : (
            <>
              <Markdown>{message.content}</Markdown>
              <MediaBlock media={message.media} type={message.mediaType} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function MediaBlock({ media, type }) {
  if (!media) return null
  const src = media.url || (media.base64 ? `data:${media.mimeType};base64,${media.base64}` : null)
  if (!src) return null
  if (type === 'audio') return <audio controls src={src} className="mt-3 w-full" />
  if (type === 'video') return <video controls src={src} className="mt-3 w-full rounded-lg" />
  if (type === 'image') return <img src={src} alt="generated" className="mt-3 max-w-full rounded-lg" />
  return null
}

function RoutingCard({ routing }) {
  const { task, primary_tool, secondary_tool, pipeline, source } = routing
  return (
    <div className="flex justify-center">
      <div className="inline-flex flex-wrap items-center gap-2 rounded-full border border-nexus-border bg-nexus-panel/60 px-3 py-1.5 text-xs text-gray-400">
        <span className="font-medium text-gray-300">🧭 Routed</span>
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-gray-300">{task}</span>
        <span className="text-gray-500">→</span>
        <span className="rounded bg-nexus-accent/15 px-1.5 py-0.5 text-nexus-accent2">{primary_tool}</span>
        {pipeline && secondary_tool && (
          <>
            <span className="text-gray-500">→</span>
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">{secondary_tool}</span>
          </>
        )}
        <span className="text-gray-600">· {source}</span>
      </div>
    </div>
  )
}

function VideoAnalysisCard({ message }) {
  const { filename, source, analysis } = message
  const badge =
    source === 'gemini'
      ? { text: 'Gemini 1.5 Pro', cls: 'bg-emerald-500/15 text-emerald-300' }
      : source === 'error'
        ? { text: 'analysis error', cls: 'bg-red-500/15 text-red-300' }
        : { text: 'stub (no Gemini key)', cls: 'bg-amber-500/15 text-amber-300' }
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[85%]">
        <div className="mb-1 flex items-center gap-2">
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-gray-300">📹 Video analysis</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.text}</span>
        </div>
        <div className="space-y-2 rounded-2xl border border-nexus-border bg-nexus-panel px-4 py-3 text-sm">
          <p className="truncate text-xs text-gray-500">{filename}</p>
          <CardField label="Scene" value={analysis.scene} />
          <CardField label="Objects" value={(analysis.objects || []).join(', ')} />
          <div className="flex gap-6">
            <CardField label="Tone" value={analysis.tone} />
            <CardField label="Duration" value={analysis.duration} />
          </div>
          {analysis.keyMoments?.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Key moments</p>
              <ul className="mt-1 space-y-0.5">
                {analysis.keyMoments.map((m, i) => (
                  <li key={i} className="text-gray-300">
                    <span className="font-mono text-gray-500">{m.time}</span> — {m.description}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CardField({ label, value }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-gray-200">{value || '—'}</p>
    </div>
  )
}

function TypingIndicator({ label }) {
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[85%]">
        <div className="mb-1">
          <span className="rounded-full bg-nexus-accent/15 px-2 py-0.5 text-[10px] font-medium text-nexus-accent2">{label}</span>
        </div>
        <div className="inline-flex items-center gap-1 rounded-2xl border border-nexus-border bg-nexus-panel px-4 py-3">
          <Dot delay="0ms" />
          <Dot delay="150ms" />
          <Dot delay="300ms" />
        </div>
      </div>
    </div>
  )
}

function Dot({ delay }) {
  return <span className="inline-block h-2 w-2 animate-bounce rounded-full bg-gray-500" style={{ animationDelay: delay }} />
}
