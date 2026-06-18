import Anthropic from '@anthropic-ai/sdk'

// Builds the final system prompt from the assembled systemPrompt plus any
// skills passed directly to the adapter (the client usually folds skills into
// systemPrompt already, but the adapter honors the documented signature).
function composeSystem(systemPrompt = '', skills = []) {
  const parts = []
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  for (const s of skills || []) {
    if (s?.content?.trim()) parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }
  return parts.join('\n\n')
}

// Text generation via the Anthropic Messages API.
// { prompt, systemPrompt, skills, apiKey, model, media } -> normalized response.
// `model` is the API model id (defaults to Claude Sonnet 4.6, the app's
// selectable Claude model). Returns a normalized { ok, provider, type, content }.
export async function run({ prompt, systemPrompt, skills, apiKey, model }) {
  if (!apiKey) throw new Error('Anthropic API key is not connected')

  const client = new Anthropic({ apiKey })
  const system = composeSystem(systemPrompt, skills)

  const response = await client.messages.create({
    model: model || 'claude-sonnet-4-6',
    max_tokens: 8192,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: prompt }],
  })

  // Concatenate any text blocks from the response content.
  const content = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')

  return {
    ok: true,
    provider: 'claude',
    type: 'text',
    content,
    model: response.model,
    usage: response.usage,
  }
}
