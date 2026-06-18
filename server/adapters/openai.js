import OpenAI from 'openai'

function composeSystem(systemPrompt = '', skills = []) {
  const parts = []
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  for (const s of skills || []) {
    if (s?.content?.trim()) parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }
  return parts.join('\n\n')
}

// Text generation via the OpenAI Chat Completions API.
// { prompt, systemPrompt, skills, apiKey, model } -> normalized response.
export async function run({ prompt, systemPrompt, skills, apiKey, model }) {
  if (!apiKey) throw new Error('OpenAI API key is not connected')

  const client = new OpenAI({ apiKey })
  const system = composeSystem(systemPrompt, skills)

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })

  const completion = await client.chat.completions.create({
    model: model || 'gpt-4o',
    max_tokens: 4096,
    messages,
  })

  return {
    ok: true,
    provider: 'openai',
    type: 'text',
    content: completion.choices?.[0]?.message?.content || '',
    model: completion.model,
    usage: completion.usage,
  }
}
