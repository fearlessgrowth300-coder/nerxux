import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import Markdown from '../components/Markdown'
import ModelControls from '../components/ModelControls'
import ComputeBar from '../components/ComputeBar'
import {
  PlusIcon, FileIcon, ImageIcon, SearchIcon, MicIcon, SkillsIcon,
  ConnectionsIcon, InstructionsIcon, SendIcon, SparkIcon, CloseIcon,
} from '../components/icons'
import { useAuth } from '../context/AuthContext'
import { sendChat, resumeChat, pollJob, listRunningJobs } from '../lib/chat'
import { uploadFile, analysisToContext } from '../lib/upload'
import { extractPdfText } from '../lib/pdf'
import { speak, stopSpeaking, speechOutputSupported } from '../lib/speech'
import { buildSystemPrompt } from '../lib/systemPrompt'
import { listSkills } from '../lib/skills'
import { getConnectors } from '../lib/mcp'
import { getPrefs } from '../lib/prefs'
import {
  listConversations, createConversation, listMessages, saveMessages,
  deleteConversation,
} from '../lib/conversations'
import { getModelById } from '@shared/models'
import { readWorkspace, writeWorkspace, editedHistory } from '../lib/chatWorkspace'

const CHIPS = [
  { label: 'Code', Icon: FileIcon, text: 'Help me write code that ' },
  { label: 'Learn', Icon: SearchIcon, text: 'Explain how ' },
  { label: 'Create', Icon: SparkIcon, text: 'Create ' },
  { label: 'Write', Icon: InstructionsIcon, text: 'Write ' },
]

function firstName(email = '') {
  const n = (email.split('@')[0] || 'there').replace(/[._-]+/g, ' ')
  return n.charAt(0).toUpperCase() + n.slice(1)
}

export default function Chat() {
  const { user } = useAuth()
  const navigate = useNavigate()
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
  const [webSearch, setWebSearch] = useState(false)
  // 'auto' attaches the build/run tools only when the message asks for work.
  // They cost ~1,250 prompt tokens per message and invite an extra API
  // request, which matters on a small free-tier allowance.
  const [agentTools, setAgentTools] = useState('auto') // 'auto' | 'on' | 'off'
  const [voiceReplies, setVoiceReplies] = useState(false) // read replies aloud (hands-free)

  const [uploading, setUploading] = useState(false)
  const [attachments, setAttachments] = useState([]) // {id,kind,filename,mimeType,base64?,analysis?}

  const [skills, setSkills] = useState([])
  const [connectors, setConnectors] = useState([])
  const [activeConnectors, setActiveConnectors] = useState(() => new Set())

  // Second brain: persistent conversations.
  const [conversationId, setConversationId] = useState(null)
  const [conversations, setConversations] = useState([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const convIdRef = useRef(null) // mirror of conversationId for async closures
  // Which storage key has actually been restored. The write effect must not
  // run for a key whose restore has not finished, or a reload can save empty
  // state over the in-flight job it was about to resume.
  const restoredKeyRef = useRef(null)
  const [ready, setReady] = useState(false)
  const busyRef = useRef(false)
  const [opening, setOpening] = useState(false)

  const scrollRef = useRef(null)
  const fileInputRef = useRef(null)
  const taRef = useRef(null)
  const abortRef = useRef(null) // aborts the in-flight turn (Stop button)
  const [liveEvents, setLiveEvents] = useState([]) // what the agent is doing right now
  // The server job for the reply in flight — persisted so that closing or
  // reloading the app (or a phone suspending the page) re-attaches to it
  // instead of losing a long build's result.
  const [pendingJob, setPendingJob] = useState(null)

  async function resumePendingJob(job) {
    if (busyRef.current) return
    busyRef.current = true
    setSending(true)
    setError('')
    const controller = new AbortController()
    abortRef.current = controller
    setLiveEvents([])
    try {
      const { messages: replies, routing } = await pollJob(job.jobId, { signal: controller.signal, onProgress: setLiveEvents })
      const toAdd = []
      if (routing) toAdd.push({ id: uuid(), role: 'routing', routing })
      for (const r of replies) toAdd.push({ id: uuid(), ...r })
      setMessages((prev) => [...prev, ...toAdd])
      if (job.conversationId) {
        try { await saveMessages(job.conversationId, toAdd) }
        catch (err) { setError(`Could not sync the reply (${err?.message || err}). A local copy is saved on this device.`) }
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(e.message)
      setMessages((prev) => [...prev, {
        id: uuid(), role: 'assistant', model: job.model,
        content: controller.signal.aborted ? '⏹ Stopped.' : `⚠️ ${e.message}`, error: !controller.signal.aborted,
      }])
    } finally {
      setPendingJob(null)
      abortRef.current = null
      setLiveEvents([])
      busyRef.current = false
      setSending(false)
    }
  }

  function stopGeneration() {
    abortRef.current?.abort()
  }

  useEffect(() => {
    let cancelled = false
    setReady(false)
    const saved = readWorkspace(localStorage, storageKey)
    setMessages(saved?.messages || [])
    setInput(saved?.input || '')
    setConversationId(saved?.conversationId || null)
    convIdRef.current = saved?.conversationId || null
    try {
      const s = JSON.parse(localStorage.getItem(settingsKey) || '{}')
      if (s.modelA) setModelA(s.modelA)
      setModelB(s.modelB ?? null)
      setPipeline(Boolean(s.pipeline))
      setAuto(Boolean(s.auto))
      setWebSearch(Boolean(s.webSearch))
      if (s.agentTools) setAgentTools(s.agentTools)
      setVoiceReplies(Boolean(s.voiceReplies))
    } catch {}
    listSkills().then(setSkills).catch(() => {})
    getConnectors()
      .then((cs) => {
        setConnectors(cs)
        // Default: all connected connectors active for this chat.
        setActiveConnectors(new Set(cs.filter((c) => c.status === 'connected').map((c) => c.id)))
      })
      .catch(() => {})
    // Resume the explicit selection, including a new empty chat.
    listConversations()
      .then(async (convs) => {
        if (cancelled) return
        setConversations(convs)
        const selected = saved ? convs.find(c => c.id === saved.conversationId) : convs[0]
        if (selected) {
          const msgs = await listMessages(selected.id)
          if (cancelled) return
          setConversationId(selected.id); convIdRef.current = selected.id
          // Keep a locally saved in-flight turn when reloading before the reply.
          const ids = new Set(msgs.map(m => m.id))
          setMessages([...msgs, ...(saved?.messages || []).filter(m => !ids.has(m.id))])
        } else if (saved?.conversationId) {
          setConversationId(null); convIdRef.current = null
        }
      })
      .catch(() => {}) // not signed in / table missing -> stay on local draft
      .finally(async () => {
        if (cancelled) return
        restoredKeyRef.current = storageKey
        setReady(true)
        // A reply was still generating when the app was last closed — pick it up.
        if (saved?.pendingJob?.jobId) {
          setPendingJob(saved.pendingJob)
          resumePendingJob(saved.pendingJob)
          return
        }
        // Nothing remembered locally, but the server may still be working on
        // something for this user — a cleared browser, another device, or a
        // reload that raced the save. Ask, rather than abandoning live work.
        try {
          const running = await listRunningJobs()
          if (cancelled || !running.length) return
          const mine = running.find((j) => j.conversationId && j.conversationId === convIdRef.current) || running[0]
          const job = { jobId: mine.jobId, conversationId: mine.conversationId, model: null }
          setPendingJob(job)
          resumePendingJob(job)
        } catch {}
      })
    return () => { cancelled = true }
  }, [storageKey, settingsKey])

  useEffect(() => {
    if (ready && restoredKeyRef.current === storageKey) writeWorkspace(localStorage, storageKey,
      { conversationId, messages, input, pendingJob }, getPrefs(user?.id).saveHistory !== false)
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, input, conversationId, pendingJob, ready, storageKey, user?.id])

  useEffect(() => {
    try {
      localStorage.setItem(settingsKey, JSON.stringify({ modelA, modelB, pipeline, auto, webSearch, voiceReplies, agentTools }))
    } catch {}
  }, [modelA, modelB, pipeline, auto, webSearch, voiceReplies, agentTools, settingsKey])

  // Hands-free: read each new reply aloud, then hand the mic back so the user
  // can answer without touching anything.
  useEffect(() => {
    if (!voiceReplies) { stopSpeaking(); return }
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant' || last.error || last.spoken) return
    last.spoken = true // mark in place so a re-render doesn't re-read it
    speak(last.content).then((finished) => {
      if (finished && voiceReplies) window.dispatchEvent(new Event('nexus:listen'))
    })
  }, [messages, voiceReplies])

  const pipelineActive = Boolean(modelA && modelB && pipeline)
  const isEmpty = messages.length === 0 && !sending

  async function handleSend(edit = null) {
    const isEdit = Boolean(edit?.id)
    const text = (isEdit ? edit.content : input).trim()
    if (!text || busyRef.current || !ready || uploading) return
    busyRef.current = true
    setError('')
    const history = isEdit ? editedHistory(messages, edit.id, text) :
      [...messages, { id: uuid(), role: 'user', content: text, attachments }]
    const userMsg = history[history.length - 1]
    const turnAttachments = userMsg.attachments || []
    setMessages(history)
    setInput('')
    setSending(true)

    // Ensure a persistent conversation exists (titled from the first message).
    let convId = isEdit ? null : convIdRef.current
    let created = false
    if (!convId) {
      setConversationId(null); convIdRef.current = null
      try {
        const conv = await createConversation(text)
        created = true
        convId = conv.id; convIdRef.current = conv.id
        setConversationId(conv.id)
        setConversations((prev) => [conv, ...prev])
      } catch (err) {
        // A bare `catch {}` here meant nobody — including me — could ever tell
        // WHY history stopped syncing. Say the actual reason.
        setError(`Chat is saved on this device; cloud history is unavailable (${err?.message || err}).`)
      }
    }
    if (convId) {
      try { await saveMessages(convId, created ? history : [userMsg]) }
      catch (err) { setError(`Could not sync this message (${err?.message || err}). A local copy is saved on this device.`) }
    }

    // Split attachments: images/pdf go to the model; videos become context text.
    // PDFs carry both the raw file (Claude/Gemini read it natively) and the
    // extracted text (for every model that can't).
    const media = turnAttachments
      .filter((a) => a.kind === 'image' || a.kind === 'pdf')
      .map((a) => ({ kind: a.kind, filename: a.filename, mimeType: a.mimeType, base64: a.base64, text: a.text }))
    const videoContext = turnAttachments
      .filter((a) => a.kind === 'video')
      .map((a) => analysisToContext(a.analysis))
      .join('\n\n') || null
    setAttachments([])

    const controller = new AbortController()
    abortRef.current = controller
    setLiveEvents([])
    try {
      const systemPrompt = await buildSystemPrompt()
      const { messages: replies, routing } = await sendChat({
        history: history.map(({ role, content }) => ({ role, content })),
        modelA, modelB, pipeline, systemPrompt, videoContext, auto,
        attachments: media,
        webSearch,
        agentTools,
        connectorIds: [...activeConnectors],
        sessionId: convId,
        signal: controller.signal,
        onProgress: setLiveEvents,
        onJob: (jobId) => setPendingJob({ jobId, conversationId: convId, model: modelA }),
      })
      setPendingJob(null)
      const toAdd = []
      if (routing) toAdd.push({ id: uuid(), role: 'routing', routing })
      for (const r of replies) toAdd.push({ id: uuid(), ...r })
      setMessages((prev) => [...prev, ...toAdd])
      // Persist this turn to the second brain.
      if (convId) {
        try { await saveMessages(convId, toAdd) }
        catch (err) { setError(`Could not sync the reply (${err?.message || err}). A local copy is saved on this device.`) }
      }
    } catch (e) {
      if (controller.signal.aborted) {
        // The user pressed Stop — keep whatever the agent got done as a note, no error styling.
        const done = liveEventsRef.current.filter((ev) => ev.type === 'tool')
        setMessages((prev) => [...prev, {
          id: uuid(), role: 'assistant', model: modelA,
          content: `⏹ Stopped.${done.length ? ` ${done.length} tool action${done.length === 1 ? '' : 's'} had already run.` : ''}`,
          ...(done.length ? { toolSteps: done } : {}),
        }])
      } else {
        setError(e.message)
        const errMsg = { id: uuid(), role: 'assistant', content: `⚠️ ${e.message}`, model: modelA, error: true }
        setMessages((prev) => [...prev, errMsg])
      }
    } finally {
      setPendingJob(null)
      abortRef.current = null
      setLiveEvents([])
      busyRef.current = false
      setSending(false)
    }
  }
  // Mirror of liveEvents for use inside async closures (the Stop path above).
  const liveEventsRef = useRef([])
  liveEventsRef.current = liveEvents

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError('')
    setUploading(true)
    try {
      const a = await uploadFile(file)
      // Pull the PDF's text out in the browser too, so models without native
      // PDF reading (GPT-4o, Groq, the local models) still get its contents.
      if (a.kind === 'pdf') {
        try { a.text = await extractPdfText(file) } catch { a.text = '' }
      }
      setAttachments((prev) => [...prev, { id: uuid(), ...a }])
      if (a.kind === 'video') {
        setMessages((prev) => [...prev, { id: uuid(), role: 'video', filename: a.filename, source: a.source, analysis: a.analysis }])
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  // Resolve a tool-approval card: send the user's decisions, append the result,
  // and mark the card resolved.
  async function handleApproval(cardId, pendingId, decisions) {
    if (busyRef.current || !ready) return
    busyRef.current = true
    setMessages((prev) => prev.map((m) => (m.id === cardId ? { ...m, resolved: true } : m)))
    setSending(true)
    try {
      const replies = await resumeChat(pendingId, decisions)
      const toAdd = replies.map((r) => ({ id: uuid(), ...r }))
      setMessages((prev) => [...prev, ...toAdd])
      if (convIdRef.current) await saveMessages(convIdRef.current, toAdd)
    } catch (e) {
      setMessages((prev) => [...prev, { id: uuid(), role: 'assistant', content: `⚠️ ${e.message}`, error: true }])
    } finally {
      busyRef.current = false
      setSending(false)
    }
  }

  function toggleConnector(id) {
    setActiveConnectors((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function newChat() {
    if (busyRef.current || !ready || uploading) return
    setMessages([])
    setInput('')
    setError('')
    setAttachments([])
    setConversationId(null); convIdRef.current = null
    setHistoryOpen(false)
  }

  async function openConversation(id) {
    if (busyRef.current || !ready || uploading) return
    busyRef.current = true
    setOpening(true)
    setHistoryOpen(false)
    setError('')
    try {
      const msgs = await listMessages(id)
      setConversationId(id); convIdRef.current = id
      setMessages(msgs)
      setInput('')
      setAttachments([])
    } catch (e) {
      setError(e.message)
    } finally {
      busyRef.current = false
      setOpening(false)
    }
  }

  async function removeConversation(id, e) {
    e.stopPropagation()
    if (busyRef.current || !ready || uploading) return
    try {
      await deleteConversation(id)
      setConversations((prev) => prev.filter((c) => c.id !== id))
      if (convIdRef.current === id) newChat()
    } catch (err) {
      setError(err.message)
    }
  }

  const composer = (
    <Composer
      input={input} setInput={setInput} onSend={() => handleSend()} sending={sending || !ready || opening}
      onStop={stopGeneration} canStop={Boolean(sending && abortRef.current)}
      uploading={uploading} onUploadClick={() => fileInputRef.current?.click()}
      skills={skills} taRef={taRef} navigate={navigate}
      connectors={connectors} activeConnectors={activeConnectors} toggleConnector={toggleConnector}
      webSearch={webSearch} setWebSearch={setWebSearch}
      agentTools={agentTools} setAgentTools={setAgentTools}
      voiceReplies={voiceReplies} setVoiceReplies={setVoiceReplies}
      attachments={attachments} removeAttachment={(id) => setAttachments((p) => p.filter((a) => a.id !== id))}
    />
  )

  return (
    <div className="flex h-full flex-col">
      <ComputeBar />
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nexus-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <AutoToggle auto={auto} setAuto={setAuto} />
          {auto ? (
            <span className="text-xs text-gray-500">The intent router picks the tools for each message.</span>
          ) : (
            <ModelControls
              modelA={modelA} modelB={modelB} pipeline={pipeline}
              onChangeA={setModelA} onChangeB={setModelB} onTogglePipeline={() => setPipeline((v) => !v)}
            />
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={newChat} disabled={sending || opening || !ready || uploading} title="Start a new conversation"
            className="flex items-center gap-1.5 rounded-lg border border-nexus-border px-3 py-1.5 text-sm text-gray-300 transition hover:bg-white/5">
            <PlusIcon className="h-4 w-4" /> New chat
          </button>
          <div className="relative">
            <button
              onClick={async () => {
                const open = !historyOpen
                setHistoryOpen(open)
                if (open) { try { setConversations(await listConversations()) } catch {} }
              }}
              title="Conversation history (your second brain)"
              className="flex items-center gap-1.5 rounded-lg border border-nexus-border px-3 py-1.5 text-sm text-gray-300 transition hover:bg-white/5">
              <SearchIcon className="h-4 w-4" /> History
            </button>
            {historyOpen && (
              <>
                <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setHistoryOpen(false)} />
                {/* Anchoring to the button pushed the panel off the left edge:
                    the button sits near the left, so a right-aligned w-80 panel
                    grows off-screen and you only see the tail of each title.
                    max-width can't fix that — only the position can. So the
                    panel is anchored to the viewport, not to the button. */}
                <div className="fixed left-1/2 top-20 z-50 max-h-[70vh] w-[92vw] max-w-md -translate-x-1/2 overflow-y-auto rounded-xl border border-nexus-border bg-nexus-panel p-1 shadow-2xl">
                  <div className="flex items-center justify-between px-3 py-1.5">
                    <p className="text-[10px] uppercase tracking-wide text-gray-500">
                      Saved conversations
                    </p>
                    <button onClick={() => setHistoryOpen(false)}
                      className="text-gray-500 transition hover:text-gray-200" title="Close">
                      <CloseIcon className="h-4 w-4" />
                    </button>
                  </div>
                  {conversations.length === 0 && (
                    <p className="px-3 py-3 text-xs text-gray-500">No saved chats yet — start chatting and they'll appear here.</p>
                  )}
                  {conversations.map((c) => (
                    <div key={c.id}
                      onClick={() => openConversation(c.id)}
                      className={['group flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 transition hover:bg-white/5',
                        c.id === conversationId ? 'bg-nexus-accent/10' : ''].join(' ')}>
                      {/* min-w-0 so a long title actually truncates instead of
                          forcing the row wider than the panel. */}
                      <span className="min-w-0 flex-1 truncate text-sm text-gray-200">{c.title || 'Untitled'}</span>
                      <span className="shrink-0 text-[10px] text-gray-600">{new Date(c.updated_at).toLocaleDateString()}</span>
                      {/* Was opacity-0 until hover — on a touch screen there is
                          no hover, so delete was unreachable on phones. */}
                      <button onClick={(e) => removeConversation(c.id, e)}
                        className="shrink-0 text-gray-600 transition hover:text-red-400 md:opacity-0 md:group-hover:opacity-100"
                        title="Delete conversation">
                        <CloseIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <input ref={fileInputRef} type="file"
        accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.mp4,.mov,.webm,image/*,application/pdf,video/mp4,video/quicktime,video/webm"
        onChange={handleFile} className="hidden" />

      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4">
          <div className="w-full max-w-2xl">
            <h1 className="mb-8 flex items-center justify-center gap-2 text-center text-3xl font-semibold text-gray-100">
              <SparkIcon className="h-7 w-7 text-nexus-accent2" />
              Welcome, {getPrefs(user?.id).callName || firstName(user?.email)}
            </h1>
            {error && <p className="mb-3 text-center text-xs text-red-400">{error}</p>}
            {composer}
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {CHIPS.map(({ label, Icon, text }) => (
                <button key={label} onClick={() => { setInput(text); taRef.current?.focus() }}
                  className="flex items-center gap-1.5 rounded-full border border-nexus-border bg-nexus-panel px-3 py-1.5 text-sm text-gray-300 transition hover:bg-white/5">
                  <Icon className="h-4 w-4 text-gray-400" />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-6">
            <div className="mx-auto w-full max-w-3xl space-y-5">
              {messages.map((m) =>
                m.role === 'video' ? <VideoAnalysisCard key={m.id} message={m} />
                  : m.role === 'routing' ? <RoutingCard key={m.id} routing={m.routing} />
                    : m.role === 'approval' ? <ApprovalCard key={m.id} message={m} onDecide={handleApproval} />
                      : <Message key={m.id} message={m} sessionId={conversationId} onEdit={(content) => handleSend({ id: m.id, content })} disabled={sending || opening || !ready || uploading} />
              )}
              {sending && (
                <WorkingCard events={liveEvents} label={pipelineActive ? `${getModelById(modelA)?.label} → ${getModelById(modelB)?.label}` : getModelById(modelA)?.label} />
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
              {composer}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ---------------- Composer ---------------- */

function Composer({
  input, setInput, onSend, sending, uploading, onUploadClick, skills, taRef, navigate,
  connectors, activeConnectors, toggleConnector, webSearch, setWebSearch, agentTools, setAgentTools, voiceReplies, setVoiceReplies,
  attachments, removeAttachment, onStop, canStop,
}) {
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [plusOpen, setPlusOpen] = useState(false)
  const [submenu, setSubmenu] = useState(null) // 'skills' | 'connectors'
  const [listening, setListening] = useState(false)
  const plusRef = useRef(null)
  const recRef = useRef(null)

  const speechSupported =
    typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)

  useEffect(() => {
    function onDoc(e) {
      if (plusRef.current && !plusRef.current.contains(e.target)) { setPlusOpen(false); setSubmenu(null) }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // Hands-free loop: after a spoken reply finishes, Chat asks us to listen again.
  useEffect(() => {
    const onListen = () => { if (!recRef.current && !sending) toggleVoice({ autoSend: true }) }
    window.addEventListener('nexus:listen', onListen)
    return () => window.removeEventListener('nexus:listen', onListen)
  })

  function onChange(e) {
    const v = e.target.value
    setInput(v)
    const m = /(?:^|\s)\/([\w-]*)$/.exec(v)
    if (m) { setSlashOpen(true); setSlashQuery(m[1].toLowerCase()) } else setSlashOpen(false)
  }
  function insertSkill(skill) {
    setInput((prev) => prev.replace(/(?:^|\s)\/[\w-]*$/, (match) => `${match.startsWith(' ') ? ' ' : ''}[skill: ${skill.name}] `))
    setSlashOpen(false); setPlusOpen(false); setSubmenu(null); taRef.current?.focus()
  }
  function onKeyDown(e) {
    if (slashOpen && e.key === 'Escape') return setSlashOpen(false)
    if (e.key === 'Enter' && !e.shiftKey && !slashOpen) { e.preventDefault(); onSend() }
  }

  function toggleVoice({ autoSend = false } = {}) {
    if (!speechSupported) return
    if (listening) { recRef.current?.stop(); return }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false
    let finalText = ''
    rec.onresult = (ev) => {
      let interim = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript
        if (ev.results[i].isFinal) finalText += t; else interim += t
      }
      setInput((prev) => (prev ? prev.replace(/\s*\[voice\].*$/, '') : '') + (finalText || interim ? ` ${finalText}${interim}`.trimStart() : ''))
    }
    rec.onend = () => {
      setListening(false); recRef.current = null
      // In hands-free mode a finished utterance is the message — send it.
      if (autoSend && finalText.trim()) setTimeout(onSend, 0)
    }
    rec.onerror = () => { setListening(false); recRef.current = null }
    recRef.current = rec
    setListening(true)
    rec.start()
  }

  const filtered = skills.filter((s) => s.name.toLowerCase().includes(slashQuery))

  return (
    <div className="relative">
      {slashOpen && filtered.length > 0 && (
        <div className="absolute bottom-full mb-2 max-h-56 w-full overflow-y-auto rounded-xl border border-nexus-border bg-nexus-panel p-1 shadow-2xl">
          <p className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-gray-500">Skills</p>
          {filtered.map((s) => (
            <button key={s.id} onClick={() => insertSkill(s)}
              className="flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition hover:bg-white/5">
              <span className="text-sm text-gray-200">{s.name}{!s.enabled && <span className="ml-2 text-[10px] text-gray-600">(off)</span>}</span>
              {s.description && <span className="truncate text-xs text-gray-500">{s.description}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-2xl border border-nexus-border bg-nexus-panel p-3 shadow-lg">
        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <span key={a.id} className="flex items-center gap-2 rounded-lg border border-nexus-border bg-nexus-bg px-2 py-1 text-xs text-gray-300">
                {a.kind === 'image' && a.base64 ? (
                  <img src={`data:${a.mimeType};base64,${a.base64}`} alt="" className="h-6 w-6 rounded object-cover" />
                ) : a.kind === 'video' ? <FileIcon className="h-4 w-4 text-gray-400" /> : <FileIcon className="h-4 w-4 text-gray-400" />}
                <span className="max-w-[160px] truncate">{a.filename}</span>
                <button onClick={() => removeAttachment(a.id)} className="text-gray-500 hover:text-gray-200"><CloseIcon className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
        )}

        <textarea ref={taRef} rows={3} value={input} onChange={onChange} onKeyDown={onKeyDown}
          placeholder="Type / for skills, or ask anything…"
          className="max-h-60 min-h-[72px] w-full resize-none bg-transparent px-1 text-sm text-gray-100 outline-none placeholder:text-gray-600" />

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            {/* "+" menu */}
            <div className="relative" ref={plusRef}>
              <button onClick={() => { setPlusOpen((v) => !v); setSubmenu(null) }} disabled={uploading || sending} title="Add"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-nexus-border text-gray-300 transition hover:bg-white/5 disabled:opacity-50">
                {uploading ? <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-600 border-t-nexus-accent2" /> : <PlusIcon className="h-5 w-5" />}
              </button>
              {plusOpen && (
                <div className="absolute bottom-full left-0 mb-2 w-64 overflow-hidden rounded-xl border border-nexus-border bg-nexus-panel p-1 shadow-2xl">
                  {submenu === null && (
                    <>
                      <MenuRow Icon={FileIcon} label="Add files or photos" hint=".png .pdf .mp4" onClick={() => { setPlusOpen(false); onUploadClick() }} />
                      <MenuRow Icon={SkillsIcon} label="Skills" chevron onClick={() => setSubmenu('skills')} />
                      <MenuRow Icon={ConnectionsIcon} label="Connectors" chevron onClick={() => setSubmenu('connectors')} />
                      <div className="my-1 border-t border-nexus-border" />
                      <MenuRow Icon={SearchIcon} label="Web search" toggle={webSearch} onClick={() => setWebSearch((v) => !v)} />
                      <MenuRow Icon={FileIcon} label="Build & run tools"
                        hint={agentTools === 'auto' ? 'auto — on when you ask for work' : agentTools === 'on' ? 'always on' : 'off'}
                        onClick={() => setAgentTools((v) => (v === 'auto' ? 'on' : v === 'on' ? 'off' : 'auto'))} />
                      {speechOutputSupported && (
                        <MenuRow Icon={MicIcon} label="Voice replies (hands-free)" hint="reads answers aloud" toggle={voiceReplies} onClick={() => setVoiceReplies((v) => !v)} />
                      )}
                    </>
                  )}
                  {submenu === 'skills' && (
                    <>
                      <BackRow onClick={() => setSubmenu(null)} />
                      <div className="max-h-52 overflow-y-auto">
                        {skills.length === 0 && <p className="px-3 py-2 text-xs text-gray-500">No skills yet.</p>}
                        {skills.map((s) => (
                          <MenuRow key={s.id} Icon={SkillsIcon} label={s.name} hint={s.enabled ? '' : 'off'} onClick={() => insertSkill(s)} />
                        ))}
                      </div>
                      <div className="my-1 border-t border-nexus-border" />
                      <MenuRow Icon={PlusIcon} label="Manage skills" onClick={() => navigate('/skills')} />
                    </>
                  )}
                  {submenu === 'connectors' && (
                    <>
                      <BackRow onClick={() => setSubmenu(null)} />
                      <div className="max-h-52 overflow-y-auto">
                        {connectors.length === 0 && <p className="px-3 py-2 text-xs text-gray-500">No connectors yet.</p>}
                        {connectors.map((c) => (
                          <button key={c.id} onClick={() => toggleConnector(c.id)} disabled={c.status !== 'connected'}
                            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-gray-200 transition hover:bg-white/5 disabled:opacity-50">
                            <ConnectionsIcon className="h-4 w-4 text-gray-400" />
                            <span className="flex-1 truncate">{c.name}</span>
                            {c.status === 'connected'
                              ? <MiniToggle on={activeConnectors.has(c.id)} />
                              : <span className="text-[10px] text-gray-600">sign-in</span>}
                          </button>
                        ))}
                      </div>
                      <div className="my-1 border-t border-nexus-border" />
                      <MenuRow Icon={PlusIcon} label="Manage connectors" onClick={() => navigate('/connections')} />
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Voice */}
            <button onClick={toggleVoice} disabled={!speechSupported || sending}
              title={speechSupported ? 'Voice input' : 'Voice not supported in this browser'}
              className={['flex h-9 w-9 items-center justify-center rounded-full border transition disabled:opacity-40',
                listening ? 'border-red-500 bg-red-500/15 text-red-400 animate-pulse' : 'border-nexus-border text-gray-300 hover:bg-white/5'].join(' ')}>
              <MicIcon className="h-5 w-5" />
            </button>

            {webSearch && (
              <span className="flex items-center gap-1 rounded-full bg-nexus-accent/15 px-2 py-1 text-[11px] text-nexus-accent2">
                <SearchIcon className="h-3 w-3" /> Web
              </span>
            )}
            {voiceReplies && (
              <span className="flex items-center gap-1 rounded-full bg-nexus-accent/15 px-2 py-1 text-[11px] text-nexus-accent2">
                <MicIcon className="h-3 w-3" /> Voice
              </span>
            )}
          </div>

          {canStop ? (
            <button onClick={onStop} title="Stop generating"
              className="flex items-center gap-1.5 rounded-xl border border-red-500/60 bg-red-500/15 px-5 py-2 text-sm font-medium text-red-300 transition hover:bg-red-500/25">
              <span className="inline-block h-3 w-3 rounded-sm bg-current" /> Stop
            </button>
          ) : (
            <button onClick={onSend} disabled={!input.trim() || sending}
              className="flex items-center gap-1.5 rounded-xl bg-nexus-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
              {sending ? '…' : <><SendIcon className="h-4 w-4" /> Send</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function MenuRow({ Icon, label, hint, chevron, toggle, onClick }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-gray-200 transition hover:bg-white/5">
      <Icon className="h-4 w-4 text-gray-400" />
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-[10px] text-gray-600">{hint}</span>}
      {chevron && <span className="text-gray-600">›</span>}
      {toggle !== undefined && <MiniToggle on={toggle} />}
    </button>
  )
}
function BackRow({ onClick }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-gray-500 transition hover:bg-white/5">
      ‹ Back
    </button>
  )
}
function MiniToggle({ on }) {
  return (
    <span className={['relative inline-flex h-3.5 w-6 items-center rounded-full transition', on ? 'bg-nexus-accent' : 'bg-gray-600'].join(' ')}>
      <span className={['inline-block h-2.5 w-2.5 transform rounded-full bg-white transition', on ? 'translate-x-3' : 'translate-x-0.5'].join(' ')} />
    </span>
  )
}

/* ---------------- subcomponents ---------------- */

function AutoToggle({ auto, setAuto }) {
  return (
    <button type="button" onClick={() => setAuto((v) => !v)} title="Auto-route: the intent router picks the tools"
      className={['flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition',
        auto ? 'border-nexus-accent bg-nexus-accent/15 text-nexus-accent2' : 'border-nexus-border text-gray-300 hover:bg-white/5'].join(' ')}>
      <MiniToggle on={auto} /> Auto-route
    </button>
  )
}

function StageBadge({ stage }) {
  if (!stage) return null
  const map = { analyst: 'bg-amber-500/15 text-amber-300', executor: 'bg-emerald-500/15 text-emerald-300' }
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${map[stage] || ''}`}>{stage}</span>
}

function ToolStepsCard({ steps = [] }) {
  const [open, setOpen] = useState(false)
  if (!steps || steps.length === 0) return null

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-nexus-border bg-nexus-bg/70 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-gray-300 hover:bg-white/5 transition"
      >
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-nexus-accent/20 text-nexus-accent2 font-bold text-[10px]">
            ⚡
          </span>
          <span className="font-semibold text-gray-200">
            Model Executed {steps.length} Tool {steps.length === 1 ? 'Action' : 'Actions'}
          </span>
        </div>
        <span className="text-[11px] text-gray-500">{open ? '▲ Hide details' : '▼ View logs'}</span>
      </button>

      {open && (
        <div className="divide-y divide-nexus-border/50 border-t border-nexus-border/50 p-2 space-y-2">
          {steps.map((st, i) => (
            <div key={i} className="pt-2">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-gray-300">
                    {st.tool}
                  </span>
                  <span className="rounded bg-nexus-accent/15 px-1.5 py-0.5 text-[10px] text-nexus-accent2">
                    {st.target === 'pod' ? '⚡ Runpod Pod' : '🔒 Local Sandbox'}
                  </span>
                </div>
                <span className={`text-[10px] font-mono ${st.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                  exit: {st.exitCode ?? 0} {st.durationMs ? `(${st.durationMs}ms)` : ''}
                </span>
              </div>
              {st.args?.command && (
                <div className="font-mono text-[11px] text-gray-300 bg-black/40 px-2 py-1 rounded">
                  $ {st.args.command}
                </div>
              )}
              {st.args?.code && (
                <pre className="max-h-24 overflow-auto rounded bg-black/40 p-2 font-mono text-[11px] text-gray-300">
                  {st.args.code}
                </pre>
              )}
              {(st.stdout || st.stderr) && (
                <pre className="mt-1 max-h-32 overflow-auto rounded bg-black/60 p-2 font-mono text-[11px] text-gray-400 whitespace-pre-wrap">
                  {st.stdout}{st.stderr ? `\nSTDERR:\n${st.stderr}` : ''}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Message({ message, sessionId, onEdit, disabled }) {
  const isUser = message.role === 'user'
  const [editing, setEditing] = useState(false)
  const [editedText, setEditedText] = useState(message.content || '')
  const [speaking, setSpeaking] = useState(false)
  function toggleSpeak() {
    if (speaking) { stopSpeaking(); setSpeaking(false); return }
    setSpeaking(true)
    speak(message.content).finally(() => setSpeaking(false))
  }
  return (
    <div className={isUser ? 'flex min-w-0 justify-end' : 'flex min-w-0 justify-start'}>
      {/* min-w-0 + overflow-wrap: long tokens (URLs, keys, hashes) wrap inside
          the bubble instead of pushing the whole row off-screen on phones. */}
      <div className={isUser ? 'min-w-0 max-w-[85%]' : 'w-full min-w-0 max-w-[85%]'}>
        {!isUser && (
          <div className="mb-1 flex items-center gap-2">
            <span className={['rounded-full px-2 py-0.5 text-[10px] font-medium', message.error ? 'bg-red-500/10 text-red-400' : 'bg-nexus-accent/15 text-nexus-accent2'].join(' ')}>
              {getModelById(message.model)?.label || message.modelLabel || 'Assistant'}
            </span>
            <StageBadge stage={message.stage} />
          </div>
        )}
        <div className={['min-w-0 max-w-full break-words [overflow-wrap:anywhere] rounded-2xl px-4 py-3', isUser ? 'bg-nexus-accent text-white' : 'border border-nexus-border bg-nexus-panel'].join(' ')}>
          {isUser ? (
            <>
              {message.attachments?.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {message.attachments.map((a) => a.kind === 'image' && a.base64
                    ? <img key={a.id} src={`data:${a.mimeType};base64,${a.base64}`} alt="" className="h-16 w-16 rounded-lg object-cover" />
                    : <span key={a.id} className="rounded bg-white/15 px-2 py-1 text-xs">{a.filename}</span>)}
                </div>
              )}
              {editing ? (
                <div className="space-y-2">
                  <textarea aria-label="Edit message" autoFocus value={editedText} onChange={e => setEditedText(e.target.value)} rows={4}
                    className="w-full min-w-[240px] rounded-lg bg-black/20 p-2 text-sm text-white outline-none" />
                  <p className="text-xs text-white/80">Continues in a new chat. Your original stays in History.</p>
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setEditing(false)} className="rounded px-2 py-1 text-xs">Cancel</button>
                    <button type="button" disabled={disabled || !editedText.trim()} onClick={() => { setEditing(false); onEdit(editedText) }}
                      className="rounded bg-white/20 px-2 py-1 text-xs disabled:opacity-40">Save &amp; resend</button>
                  </div>
                </div>
              ) : <p className="whitespace-pre-wrap text-sm">{message.content}</p>}
            </>
          ) : (
            <>
              {message.toolSteps?.length > 0 && <ToolStepsCard steps={message.toolSteps} />}
              <Markdown sessionId={sessionId}>{message.content}</Markdown>
              <MediaBlock media={message.media} type={message.mediaType} list={message.mediaList} />
            </>
          )}
        </div>
        {!isUser && !message.error && speechOutputSupported && message.content && (
          <div className="mt-1 flex gap-2 text-xs text-gray-400">
            <button type="button" onClick={toggleSpeak} title={speaking ? 'Stop reading' : 'Read aloud'}
              className={['rounded px-2 py-1 hover:bg-white/10 hover:text-white', speaking ? 'text-nexus-accent2' : ''].join(' ')}>
              {speaking ? '■ Stop' : '🔊 Read aloud'}
            </button>
          </div>
        )}
        {isUser && !editing && <div className="mt-1 flex justify-end gap-2 text-xs text-gray-400">
          {message.edited && <span>Edited</span>}
          <button type="button" disabled={disabled} onClick={() => { setEditedText(message.content); setEditing(true) }}
            className="rounded px-2 py-1 hover:bg-white/10 hover:text-white disabled:opacity-40">Edit</button>
        </div>}
      </div>
    </div>
  )
}

// Anything a connector generated this turn — shown inline so you never have to
// go back to the provider's own site to see the result, each with a download.
function MediaBlock({ media, type, list }) {
  const items = list?.length ? list : media ? [{ ...media, type: media.type || type }] : []
  if (!items.length) return null
  return (
    <div className="mt-3 space-y-3">
      {items.map((m, i) => <MediaItem key={(m.url || '') + i} item={m} />)}
    </div>
  )
}

function MediaItem({ item }) {
  const src = item.url || (item.base64 ? `data:${item.mimeType};base64,${item.base64}` : null)
  if (!src) return null
  const ext = (item.mimeType?.split('/')[1] || 'bin').replace('jpeg', 'jpg')
  const name = `nexus-${item.type || 'file'}-${Date.now()}.${ext}`
  return (
    <div>
      {item.type === 'audio' && <audio controls src={src} className="w-full" />}
      {item.type === 'video' && <video controls playsInline src={src} className="w-full rounded-lg" />}
      {item.type === 'image' && <img src={src} alt="generated" className="max-w-full rounded-lg" />}
      {!['audio', 'video', 'image'].includes(item.type) && (
        <p className="text-xs text-gray-400">Generated file</p>
      )}
      {/* A cross-origin `download` is ignored by the browser and just opens the
          file, so the link says "Open / download" rather than promising a save. */}
      <a href={src} download={name} target="_blank" rel="noreferrer"
        className="mt-1 inline-block text-xs text-nexus-accent2 hover:underline">
        ↓ Open / download
      </a>
    </div>
  )
}

function ApprovalCard({ message, onDecide }) {
  const { id, pendingId, tools = [], modelLabel, resolved } = message
  function decide(decision) {
    const decisions = {}
    for (const t of tools) decisions[t.id] = decision
    onDecide(id, pendingId, decisions)
  }
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[85%]">
        <div className="mb-1 flex items-center gap-2">
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">Approval needed</span>
          {modelLabel && <span className="text-[10px] text-gray-500">{modelLabel}</span>}
        </div>
        <div className="space-y-2 rounded-2xl border border-amber-500/30 bg-nexus-panel px-4 py-3 text-sm">
          <p className="text-gray-300">{modelLabel || 'The model'} wants to run {tools.length === 1 ? 'a tool' : 'these tools'}:</p>
          <ul className="space-y-1">
            {tools.map((t) => (
              <li key={t.id} className="rounded-lg bg-nexus-bg px-3 py-2 text-xs">
                <span className="font-mono text-gray-200">{t.name}</span>
                {t.input && Object.keys(t.input).length > 0 && (
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-gray-500">{JSON.stringify(t.input, null, 2)}</pre>
                )}
              </li>
            ))}
          </ul>
          {resolved ? (
            <p className="text-xs text-gray-500">Decision sent.</p>
          ) : (
            <div className="flex gap-2 pt-1">
              <button onClick={() => decide('approve')} className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500">Approve</button>
              <button onClick={() => decide('deny')} className="rounded-lg border border-nexus-border px-4 py-1.5 text-xs text-gray-300 transition hover:bg-white/5">Deny</button>
            </div>
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
        <span className="rounded bg-nexus-accent/15 px-1.5 py-0.5 text-nexus-accent2">{primary_tool}</span>
        {pipeline && secondary_tool && (<><span className="text-gray-500">→</span><span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">{secondary_tool}</span></>)}
        <span className="text-gray-600">· {source}</span>
      </div>
    </div>
  )
}

function VideoAnalysisCard({ message }) {
  const { filename, source, analysis } = message
  const badge = source === 'gemini' ? { text: 'Gemini 1.5 Pro', cls: 'bg-emerald-500/15 text-emerald-300' }
    : source === 'error' ? { text: 'analysis error', cls: 'bg-red-500/15 text-red-300' }
      : { text: 'stub (no Gemini key)', cls: 'bg-amber-500/15 text-amber-300' }
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[85%]">
        <div className="mb-1 flex items-center gap-2">
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-gray-300">Video analysis</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.text}</span>
        </div>
        <div className="space-y-2 rounded-2xl border border-nexus-border bg-nexus-panel px-4 py-3 text-sm">
          <p className="truncate text-xs text-gray-500">{filename}</p>
          <CardField label="Scene" value={analysis.scene} />
          <CardField label="Objects" value={(analysis.objects || []).join(', ')} />
          <div className="flex gap-6"><CardField label="Tone" value={analysis.tone} /><CardField label="Duration" value={analysis.duration} /></div>
        </div>
      </div>
    </div>
  )
}
function CardField({ label, value }) {
  return (<div><p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</p><p className="text-gray-200">{value || '—'}</p></div>)
}

// Live view of the turn in progress: every tool action the agent has run so
// far and what it said in between — the same trail a terminal agent prints —
// instead of three dots for minutes.
function WorkingCard({ label, events = [] }) {
  const tools = events.filter((e) => e.type === 'tool')
  const lastText = [...events].reverse().find((e) => e.type === 'text')?.text
  const recent = events.slice(-8)
  // A live clock so a long turn never looks frozen: total elapsed, and how
  // long since the agent last did something visible.
  const startRef = useRef(Date.now())
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const lastAt = events.length ? events[events.length - 1].at || now : startRef.current
  const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s` }
  const idle = now - lastAt
  return (
    <div className="flex justify-start">
      <div className="w-full min-w-0 max-w-[85%]">
        <div className="mb-1"><span className="rounded-full bg-nexus-accent/15 px-2 py-0.5 text-[10px] font-medium text-nexus-accent2">{label}</span></div>
        <div className="min-w-0 rounded-2xl border border-nexus-border bg-nexus-panel px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-gray-300">
            <span className="inline-flex items-center gap-1"><Dot delay="0ms" /><Dot delay="150ms" /><Dot delay="300ms" /></span>
            <span>{tools.length ? `Working — ${tools.length} tool action${tools.length === 1 ? '' : 's'} so far` : 'Thinking…'}</span>
            <span className="text-xs text-gray-500">· {fmt(now - startRef.current)} elapsed</span>
            <span className={['text-xs', idle > 90000 ? 'text-amber-400' : 'text-gray-500'].join(' ')}>
              · {idle < 3000 ? 'active now' : `model generating for ${fmt(idle)}`}
            </span>
          </div>
          {recent.length > 0 && (
            <div className="mt-2 space-y-1 border-t border-nexus-border/50 pt-2 font-mono text-[11px]">
              {recent.map((ev, i) => ev.type === 'tool' ? (
                <div key={i} className="flex min-w-0 items-start gap-2 text-gray-400">
                  <span className={ev.ok ? 'text-emerald-400' : 'text-red-400'}>{ev.ok ? '✓' : '✗'}</span>
                  <span className="shrink-0 text-nexus-accent2">{ev.tool}</span>
                  <span className="min-w-0 flex-1 truncate">{summarizeArgs(ev.args)}</span>
                  {ev.durationMs != null && <span className="shrink-0 text-gray-600">{(ev.durationMs / 1000).toFixed(1)}s</span>}
                </div>
              ) : (
                <div key={i} className="whitespace-pre-wrap break-words font-sans text-gray-500">{String(ev.text).slice(0, 300)}</div>
              ))}
            </div>
          )}
          {lastText && recent[recent.length - 1]?.type !== 'text' && (
            <p className="mt-2 break-words text-xs text-gray-500">{String(lastText).slice(0, 200)}</p>
          )}
        </div>
      </div>
    </div>
  )
}
function summarizeArgs(args = {}) {
  const v = args.command || args.query || args.path || args.pattern || args.code || ''
  return String(v).split('\n')[0].slice(0, 120) || JSON.stringify(args).slice(0, 120)
}
function Dot({ delay }) {
  return <span className="inline-block h-2 w-2 animate-bounce rounded-full bg-gray-500" style={{ animationDelay: delay }} />
}
