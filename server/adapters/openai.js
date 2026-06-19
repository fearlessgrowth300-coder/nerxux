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
export async function run({ prompt, systemPrompt, skills, apiKey, model, attachments }) {
  if (!apiKey) throw new Error('OpenAI API key is not connected')

  const client = new OpenAI({ apiKey })
  const system = composeSystem(systemPrompt, skills)

  // Images can be sent inline; PDFs aren't supported by chat completions, so
  // note them in the text instead.
  const images = (attachments || []).filter((a) => a.kind === 'image' && a.base64)
  const pdfs = (attachments || []).filter((a) => a.kind === 'pdf')
  let userContent
  if (images.length) {
    userContent = [
      { type: 'text', text: prompt + (pdfs.length ? `\n(Note: ${pdfs.length} PDF attachment(s) can't be read by this model.)` : '') },
      ...images.map((a) => ({ type: 'image_url', image_url: { url: `data:${a.mimeType};base64,${a.base64}` } })),
    ]
  } else {
    userContent = prompt + (pdfs.length ? `\n(Note: PDF attachments aren't supported by this model.)` : '')
  }

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: userContent })

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
