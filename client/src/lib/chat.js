import { api, apiError } from './api'

// Sends the conversation + model selection to the backend.
// `history` is [{ role, content }].
// Manual mode: pass modelA/modelB/pipeline.
// Auto mode: pass auto:true and the intent router decides.
// Returns { messages: [...], routing?: {...} }.
export async function sendChat({
  history,
  modelA,
  modelB,
  pipeline,
  systemPrompt,
  videoContext,
  auto = false,
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
    })
    return { messages: data.messages, routing: data.routing || null }
  } catch (err) {
    throw apiError(err, 'Chat request failed')
  }
}
