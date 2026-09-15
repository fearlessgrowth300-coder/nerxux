// Store the selected conversation together with its local draft. An empty draft
// is an intentional selection, not a request to reopen the latest conversation.
//
// `pendingJob` remembers a reply that's still being generated on the server
// ({ jobId, conversationId, model }) so that closing/reloading the app — or a
// phone that suspended the page — can re-attach to it and still receive the
// answer instead of losing it.
export function readWorkspace(storage, key) {
  try {
    const raw = storage.getItem(key)
    if (raw === null) return null
    const value = JSON.parse(raw)
    if (Array.isArray(value)) return { conversationId: null, messages: value, input: '', pendingJob: null }
    if (value?.version === 2 && Array.isArray(value.messages)) return { pendingJob: null, ...value }
  } catch {}
  return null
}

export function writeWorkspace(storage, key, workspace, saveHistory = true) {
  try {
    storage.setItem(key, JSON.stringify({
      version: 2, conversationId: workspace.conversationId,
      messages: saveHistory ? workspace.messages : [],
      input: saveHistory ? workspace.input : '',
      pendingJob: workspace.pendingJob || null,
    }))
  } catch {} // Storage quota must not prevent chatting.
}

// True when the conversation already holds an answer to its latest message —
// i.e. a reply the server saved while this device wasn't watching.
export function hasReplyToLastMessage(messages) {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user')
  return lastUser >= 0 && messages.slice(lastUser + 1).some((m) => m.role === 'assistant' && !m.error)
}

// Cloud history plus what only this device has (a turn sent but not synced).
// Local error cards ("⚠️ That request has expired…") are dropped once the
// cloud copy holds the real reply — otherwise the stale error stays pinned
// under the answer and it looks like nothing came back.
export function mergeHistory(cloud, local = []) {
  const ids = new Set(cloud.map((m) => m.id).filter(Boolean))
  const answered = hasReplyToLastMessage(cloud)
  return [...cloud, ...local.filter((m) => !ids.has(m.id) && !(answered && m.error))]
}

export function editedHistory(messages, id, content) {
  const index = messages.findIndex(m => m.id === id && m.role === 'user')
  if (index < 0 || !content.trim()) throw new Error('Enter a message to resend.')
  return [...messages.slice(0, index), { ...messages[index], content: content.trim(), edited: true }]
}
