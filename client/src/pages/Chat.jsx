import { useEffect, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import Markdown from '../components/Markdown'
import ModelControls from '../components/ModelControls'
import { PaperclipIcon } from '../components/icons'
import { useAuth } from '../context/AuthContext'
import { sendChat } from '../lib/chat'
import { uploadVideo, analysisToContext } from '../lib/upload'
import { buildSystemPrompt } from '../lib/systemPrompt'
import { getModelById } from '@shared/models'

export default function Chat() {
  const { user } = useAuth()
  const storageKey = `nexus.chat.${user?.id || 'anon'}`
  const settingsKey = `nexus.chatModels.${user?.id || 'anon'}`

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  // Model selection (persisted per user).
  const [modelA, setModelA] = useState('claude-sonnet')
  const [modelB, setModelB] = useState(null)
  const [pipeline, setPipeline] = useState(false)
  const [auto, setAuto] = useState(false) // intent-router mode (Step 10)

  // Video upload (Step 9): the analysis pending injection into the next message.
  const [uploading, setUploading] = useState(false)
  const [pendingVideo, setPendingVideo] = useState(null) // { filename, analysis }
  const fileInputRef = useRef(null)

  const scrollRef = useRef(null)

  // Restore history + model settings for this user.
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
  }, [storageKey, settingsKey])

  // Persist history + autoscroll.
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(messages))
    } catch {}
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending, storageKey])

  // Persist model settings.
  useEffect(() => {
    try {
      localStorage.setItem(settingsKey, JSON.stringify({ modelA, modelB, pipeline, auto }))
    } catch {}
  }, [modelA, modelB, pipeline, auto, settingsKey])

  const pipelineActive = Boolean(modelA && modelB && pipeline)

  async function handleSend() {
    const text = input.trim()
    if (!text || sending) return

    setError('')
    const userMsg = { id: uuid(), role: 'user', content: text }
    const history = [...messages, userMsg]
    setMessages(history)
    setInput('')
    setSending(true)

    // Inject any pending video analysis into this turn, then clear it.
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

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return

    setError('')
    setUploading(true)
    try {
      const { filename, source, analysis } = await uploadVideo(file)
      setPendingVideo({ filename, analysis })
      // Drop a "video analyzed" card into the thread.
      setMessages((prev) => [
        ...prev,
        { id: uuid(), role: 'video', filename, source, analysis },
      ])
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

  return (
    <div className="flex h-full flex-col">
      {/* Header with model controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nexus-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setAuto((v) => !v)}
            title="Auto-route: the intent router picks the tools for each message"
            className={[
              'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition',
              auto
                ? 'border-nexus-accent bg-nexus-accent/15 text-nexus-accent2'
                : 'border-nexus-border text-gray-300 hover:bg-white/5',
            ].join(' ')}
          >
            <span
              className={[
                'relative inline-flex h-3.5 w-6 items-center rounded-full transition',
                auto ? 'bg-nexus-accent' : 'bg-gray-600',
              ].join(' ')}
            >
              <span
                className={[
                  'inline-block h-2.5 w-2.5 transform rounded-full bg-white transition',
                  auto ? 'translate-x-3' : 'translate-x-0.5',
                ].join(' ')}
              />
            </span>
            Auto-route
          </button>

          {auto ? (
            <span className="text-xs text-gray-500">
              The intent router picks the tools for each message.
            </span>
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

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl space-y-5">
          {messages.length === 0 && !sending && (
            <div className="mt-20 text-center">
              <h2 className="text-lg font-medium text-gray-200">Start a conversation</h2>
              <p className="mt-1 text-sm text-gray-500">
                {pipelineActive
                  ? `Pipeline: ${getModelById(modelA)?.label} → ${getModelById(modelB)?.label}`
                  : 'Your Instructions and enabled Skills are applied automatically.'}
              </p>
            </div>
          )}

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

      {/* Composer */}
      <div className="border-t border-nexus-border px-4 py-3">
        <div className="mx-auto w-full max-w-3xl">
          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
          {pipelineActive && (
            <p className="mb-2 text-xs text-nexus-accent2">
              Pipeline mode on — {getModelById(modelA)?.label} analyzes, then{' '}
              {getModelById(modelB)?.label} executes.
            </p>
          )}
          {pendingVideo && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-nexus-accent/10 px-3 py-1.5 text-xs text-nexus-accent2">
              <span className="truncate">
                📹 {pendingVideo.filename} — analysis will be injected into your next message
              </span>
              <button
                onClick={() => setPendingVideo(null)}
                className="text-gray-400 hover:text-gray-200"
              >
                ✕
              </button>
            </div>
          )}
          <div className="flex items-end gap-2 rounded-2xl border border-nexus-border bg-nexus-panel p-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
              onChange={handleFile}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
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
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message Nexus AI…  (Enter to send, Shift+Enter for newline)"
              className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-gray-100 outline-none placeholder:text-gray-600"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="rounded-xl bg-nexus-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? '…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- subcomponents ----

function StageBadge({ stage }) {
  if (!stage) return null
  const map = {
    analyst: 'bg-amber-500/15 text-amber-300',
    executor: 'bg-emerald-500/15 text-emerald-300',
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${map[stage] || ''}`}>
      {stage}
    </span>
  )
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

function RoutingCard({ routing }) {
  const { task, primary_tool, secondary_tool, pipeline, source } = routing
  return (
    <div className="flex justify-center">
      <div className="inline-flex flex-wrap items-center gap-2 rounded-full border border-nexus-border bg-nexus-panel/60 px-3 py-1.5 text-xs text-gray-400">
        <span className="font-medium text-gray-300">🧭 Routed</span>
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-gray-300">{task}</span>
        <span className="text-gray-500">→</span>
        <span className="rounded bg-nexus-accent/15 px-1.5 py-0.5 text-nexus-accent2">
          {primary_tool}
        </span>
        {pipeline && secondary_tool && (
          <>
            <span className="text-gray-500">→</span>
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">
              {secondary_tool}
            </span>
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
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-gray-300">
            📹 Video analysis
          </span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.cls}`}>
            {badge.text}
          </span>
        </div>
        <div className="space-y-2 rounded-2xl border border-nexus-border bg-nexus-panel px-4 py-3 text-sm">
          <p className="truncate text-xs text-gray-500">{filename}</p>
          <Field label="Scene" value={analysis.scene} />
          <Field label="Objects" value={(analysis.objects || []).join(', ')} />
          <div className="flex gap-6">
            <Field label="Tone" value={analysis.tone} />
            <Field label="Duration" value={analysis.duration} />
          </div>
          {analysis.keyMoments?.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Key moments
              </p>
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

function Field({ label, value }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p className="text-gray-200">{value || '—'}</p>
    </div>
  )
}

function MediaBlock({ media, type }) {
  if (!media) return null
  const src = media.url || (media.base64 ? `data:${media.mimeType};base64,${media.base64}` : null)
  if (!src) return null

  if (type === 'audio') {
    return <audio controls src={src} className="mt-3 w-full" />
  }
  if (type === 'video') {
    return <video controls src={src} className="mt-3 w-full rounded-lg" />
  }
  if (type === 'image') {
    return <img src={src} alt="generated" className="mt-3 max-w-full rounded-lg" />
  }
  return null
}

function TypingIndicator({ label }) {
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[85%]">
        <div className="mb-1">
          <span className="rounded-full bg-nexus-accent/15 px-2 py-0.5 text-[10px] font-medium text-nexus-accent2">
            {label}
          </span>
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
  return (
    <span
      className="inline-block h-2 w-2 animate-bounce rounded-full bg-gray-500"
      style={{ animationDelay: delay }}
    />
  )
}
