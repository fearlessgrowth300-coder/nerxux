import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from '../components/Markdown'
import { PlusIcon, FileIcon, CloseIcon } from '../components/icons'
import {
  listNotes, createNote, updateNote, deleteNote, outgoingLinks, backlinks,
} from '../lib/notes'
import { extractPdfText } from '../lib/pdf'

// Obsidian-style knowledge base: markdown notes with [[wiki links]] + backlinks.
// Notes toggled "AI knowledge" are fed to the model in chat (see systemPrompt).
export default function Notes() {
  const [notes, setNotes] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [inContext, setInContext] = useState(false)
  const [mode, setMode] = useState('edit') // 'edit' | 'preview'
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const pdfRef = useRef(null)
  const savedRef = useRef({ title: '', content: '', inContext: false })

  const active = notes.find((n) => n.id === activeId) || null
  const dirty = active && (title !== savedRef.current.title ||
    content !== savedRef.current.content || inContext !== savedRef.current.inContext)

  useEffect(() => {
    listNotes().then((ns) => {
      setNotes(ns)
      if (ns.length) select(ns[0])
    }).catch((e) => setError(e.message))
  }, [])

  function select(n) {
    setActiveId(n.id)
    setTitle(n.title); setContent(n.content); setInContext(!!n.in_context)
    savedRef.current = { title: n.title, content: n.content, inContext: !!n.in_context }
    setMode('edit'); setError('')
  }

  async function onNew() {
    setError('')
    try {
      const n = await createNote({ title: 'Untitled', content: '' })
      setNotes((p) => [n, ...p]); select(n)
    } catch (e) { setError(e.message) }
  }

  async function save() {
    if (!active || !dirty) return
    try {
      const updated = await updateNote(active.id, { title: title || 'Untitled', content, in_context: inContext })
      setNotes((p) => p.map((n) => (n.id === updated.id ? updated : n)))
      savedRef.current = { title: updated.title, content: updated.content, inContext: !!updated.in_context }
      setSavedAt(new Date())
    } catch (e) { setError(e.message) }
  }

  async function onDelete() {
    if (!active) return
    try {
      await deleteNote(active.id)
      const rest = notes.filter((n) => n.id !== active.id)
      setNotes(rest)
      rest.length ? select(rest[0]) : (setActiveId(null), setTitle(''), setContent(''))
    } catch (e) { setError(e.message) }
  }

  // Upload a PDF -> extract its text -> create a note flagged as AI knowledge.
  async function onUploadPdf(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(''); setImporting(true)
    try {
      const text = await extractPdfText(file)
      if (!text.trim()) throw new Error('No text found (is it a scanned image PDF?)')
      const name = file.name.replace(/\.pdf$/i, '')
      const n = await createNote({ title: name, content: text })
      const withCtx = await updateNote(n.id, { in_context: true }) // on by default
      setNotes((p) => [withCtx, ...p]); select(withCtx)
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  // Open a note by title; create it if it doesn't exist yet (Obsidian behavior).
  async function openByTitle(t) {
    await save()
    const found = notes.find((n) => n.title.toLowerCase() === t.toLowerCase())
    if (found) return select(found)
    try {
      const n = await createNote({ title: t, content: '' })
      setNotes((p) => [n, ...p]); select(n)
    } catch (e) { setError(e.message) }
  }

  const links = useMemo(() => outgoingLinks(content), [content])
  const linkedFrom = useMemo(
    () => (active ? backlinks(notes, savedRef.current.title) : []),
    [notes, active])

  return (
    <div className="flex h-full">
      {/* Note list */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-nexus-border">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold text-gray-200">Notes</span>
          <div className="flex items-center gap-1">
            <button onClick={() => pdfRef.current?.click()} disabled={importing} title="Upload a PDF as a knowledge note"
              className="rounded-lg border border-nexus-border p-1.5 text-gray-300 hover:bg-white/5 disabled:opacity-50">
              {importing
                ? <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-600 border-t-nexus-accent2" />
                : <FileIcon className="h-4 w-4" />}
            </button>
            <button onClick={onNew} title="New note"
              className="rounded-lg border border-nexus-border p-1.5 text-gray-300 hover:bg-white/5">
              <PlusIcon className="h-4 w-4" />
            </button>
          </div>
          <input ref={pdfRef} type="file" accept=".pdf,application/pdf" onChange={onUploadPdf} className="hidden" />
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {notes.length === 0 && <p className="px-2 py-3 text-xs text-gray-500">No notes yet. Create one — link with [[Title]].</p>}
          {notes.map((n) => (
            <button key={n.id} onClick={() => { save(); select(n) }}
              className={['flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition',
                n.id === activeId ? 'bg-nexus-accent/15 text-white' : 'text-gray-300 hover:bg-white/5'].join(' ')}>
              <FileIcon className="h-4 w-4 shrink-0 text-gray-500" />
              <span className="flex-1 truncate">{n.title || 'Untitled'}</span>
              {n.in_context && <span className="text-[9px] text-nexus-accent2" title="Used as AI knowledge">AI</span>}
            </button>
          ))}
        </div>
      </aside>

      {/* Editor */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {!active ? (
          <div className="flex flex-1 items-center justify-center text-sm text-gray-500">
            Select a note, or create one. Link notes with <code className="mx-1 rounded bg-white/5 px-1">[[Title]]</code>.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-nexus-border px-4 py-3">
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="Note title"
                className="min-w-0 flex-1 bg-transparent text-lg font-semibold text-gray-100 outline-none placeholder:text-gray-600" />
              <label className="flex items-center gap-1.5 text-xs text-gray-400" title="Feed this note to the AI as knowledge">
                <input type="checkbox" checked={inContext} onChange={(e) => setInContext(e.target.checked)} />
                AI knowledge
              </label>
              <button onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}
                className="rounded-lg border border-nexus-border px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/5">
                {mode === 'edit' ? 'Preview' : 'Edit'}
              </button>
              <button onClick={save} disabled={!dirty}
                className="rounded-lg bg-nexus-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50">
                {dirty ? 'Save' : 'Saved'}
              </button>
              <button onClick={onDelete} title="Delete note"
                className="rounded-lg border border-nexus-border p-1.5 text-gray-400 hover:text-red-400">
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>

            {error && <p className="px-4 pt-2 text-xs text-red-400">{error}</p>}

            <div className="flex-1 overflow-y-auto px-4 py-4">
              {mode === 'edit' ? (
                <textarea value={content} onChange={(e) => setContent(e.target.value)}
                  placeholder="Write markdown… link other notes with [[Title]]"
                  className="h-full min-h-[300px] w-full resize-none bg-transparent font-mono text-sm leading-relaxed text-gray-100 outline-none placeholder:text-gray-600"
                  spellCheck={false} />
              ) : (
                <div className="prose prose-invert max-w-none"><Markdown>{content || '_empty_'}</Markdown></div>
              )}
            </div>

            {/* Links + backlinks (the graph) */}
            <div className="space-y-2 border-t border-nexus-border px-4 py-3 text-xs">
              <LinkRow label="Links in this note" items={links} onOpen={openByTitle}
                empty="none — add [[Title]] to link" />
              <LinkRow label="Backlinks" items={linkedFrom.map((n) => n.title)} onOpen={openByTitle}
                empty="no notes link here yet" />
              <span className="text-gray-600">{savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : ''}</span>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function LinkRow({ label, items, onOpen, empty }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] uppercase tracking-wide text-gray-500">{label}:</span>
      {items.length === 0 ? <span className="text-gray-600">{empty}</span> : items.map((t) => (
        <button key={t} onClick={() => onOpen(t)}
          className="rounded-full border border-nexus-border bg-nexus-panel px-2.5 py-1 text-gray-300 transition hover:border-nexus-accent hover:text-white">
          [[{t}]]
        </button>
      ))}
    </div>
  )
}
