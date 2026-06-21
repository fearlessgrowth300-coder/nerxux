import OpenAI from 'openai'

function composeSystem(systemPrompt = '', skills = []) {
  const parts = []
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  for (const s of skills || []) {
    if (s?.content?.trim()) parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }
  return parts.join('\n\n')
}

// Text generation via OpenAI Chat Completions, with image attachments and
// tool calling (so GPT-4o can use connected MCP / native tools, e.g. Higgsfield
// image/video generation).
// { prompt, systemPrompt, skills, apiKey, model, attachments, tools?, onToolCall? }
export async function run({ prompt, systemPrompt, skills, apiKey, model, attachments, tools, onToolCall }) {
  if (!apiKey) throw new Error('OpenAI API key is not connected')

  const client = new OpenAI({ apiKey })
  const system = composeSystem(systemPrompt, skills)

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

  // Convert Anthropic-style tool defs to OpenAI function tools.
  const hasTools = Array.isArray(tools) && tools.length > 0 && typeof onToolCall === 'function'
  const oaTools = hasTools
    ? tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
      }))
    : undefined

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: userContent })

  let lastMedia = null
  let completion
  const MAX_TURNS = 8

  for (let i = 0; i < MAX_TURNS; i++) {
    completion = await client.chat.completions.create({
      model: model || 'gpt-4o',
      max_tokens: 4096,
      messages,
      ...(oaTools ? { tools: oaTools } : {}),
    })
    const msg = completion.choices?.[0]?.message
    if (!msg?.tool_calls?.length) break

    messages.push(msg) // assistant message carrying tool_calls
    for (const tc of msg.tool_calls) {
      let args = {}
      try { args = JSON.parse(tc.function.arguments || '{}') } catch {}
      let content = ''
      try {
        let res = await onToolCall(tc.function.name, args)
        if (typeof res === 'string') res = { content: res }
        content = res.content
        if (res.media) lastMedia = res.media
      } catch (e) {
        content = `Tool error: ${e.message}`
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(content ?? '') })
    }
  }

  return {
    ok: true,
    provider: 'openai',
    type: lastMedia ? lastMedia.type : 'text',
    content: completion.choices?.[0]?.message?.content || '',
    model: completion.model,
    usage: completion.usage,
    ...(lastMedia ? { media: lastMedia } : {}),
  }
}
