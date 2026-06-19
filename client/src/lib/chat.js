import { api, apiError } from './api'

// Sends the conversation + options to the backend.
// Returns { messages: [...], routing?: {...} }.
export async function sendChat({
  history,
  modelA,
  modelB,
  pipeline,
  systemPrompt,
  videoContext,
  auto = false,
  attachments,
  webSearch,
  connectorIds,
}) {
  try {
    const { data } = await api.post('/api/chat', {
      history,
      modelA,
      modelB,
      pipeline,
      systemPrompt,
      videoContext,
      auto,
      attachments,
      webSearch,
      connectorIds,
    })
    return { messages: data.messages, routing: data.routing || null }
  } catch (err) {
    throw apiError(err, 'Chat request failed')
  }
}

// Continues a paused turn after the user approves/denies tools.
// decisions: { [toolUseId]: 'approve' | 'deny' }
export async function resumeChat(pendingId, decisions) {
  try {
    const { data } = await api.post('/api/chat/resume', { pendingId, decisions })
    return data.messages
  } catch (err) {
    throw apiError(err, 'Resume failed')
  }
}

