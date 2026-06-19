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
