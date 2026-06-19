import { v4 as uuid } from 'uuid'

// Short-lived in-memory store of paused tool-approval states. When the Claude
// agent hits a tool that needs approval, we stash the conversation state here
// and hand the client a pendingId; the client resumes after the user decides.
const store = new Map()
const TTL_MS = 10 * 60 * 1000 // 10 minutes

export function savePending(state) {
  const id = uuid()
  store.set(id, { ...state, createdAt: Date.now() })
  return id
}

export function takePending(id) {
  const entry = store.get(id)
  if (!entry) return null
  store.delete(id)
  if (Date.now() - entry.createdAt > TTL_MS) return null
  return entry
}

// Periodic cleanup of expired entries.
setInterval(() => {
  const now = Date.now()
  for (const [id, e] of store) if (now - e.createdAt > TTL_MS) store.delete(id)
}, TTL_MS).unref?.()
