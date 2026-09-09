import OpenAI from 'openai'
import { withDocuments } from '../lib/attachments.js'

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
// { prompt, systemPrompt, skills, apiKey, model, attachments, tools?, onToolCall?, webSearch? }
export async function run({ prompt, systemPrompt, skills, apiKey, model, attachments, tools, onToolCall, webSearch, signal }) {
  if (!apiKey) throw new Error('OpenAI API key is not connected')

  const client = new OpenAI({ apiKey })
  const system = composeSystem(systemPrompt, skills)
  const hasCustomTools = Array.isArray(tools) && tools.length > 0 && typeof onToolCall === 'function'

  // Native web search (Responses API — OpenAI runs the search itself, real
  // pages with citations, no scraping needed). Only for the plain-chat case:
  // the Responses API's tool-calling shape differs from Chat Completions, so
  // this doesn't try to also drive the MCP tool loop below in the same call.
  if (webSearch && !hasCustomTools && !(attachments || []).some((a) => a.kind === 'image')) {
    const resp = await client.responses.create({
      model: model || 'gpt-4o',
      tools: [{ type: 'web_search_preview' }],
      input: system ? `${system}\n\n${withDocuments(prompt, attachments)}` : withDocuments(prompt, attachments),
    })
    const citations = (resp.output || [])
      .flatMap((o) => o.content || [])
      .flatMap((c) => c.annotations || [])
      .filter((a) => a.type === 'url_citation' && a.url)
    const unique = [...new Map(citations.map((c) => [c.url, c])).values()]
    let content = resp.output_text || ''
    if (unique.length) {
      content += '\n\n**Sources:**\n' + unique.map((c) => `- [${c.title || c.url}](${c.url})`).join('\n')
    }
    return { ok: true, provider: 'openai', type: 'text', content, model: resp.model || model, usage: resp.usage }
  }

  const images = (attachments || []).filter((a) => a.kind === 'image' && a.base64)
  // PDFs: the client extracts their text, so the model reads the document
  // rather than being told it can't.
  const promptWithDocs = withDocuments(prompt, attachments)
  let userContent
  if (images.length) {
    userContent = [
      { type: 'text', text: promptWithDocs },
      ...images.map((a) => ({ type: 'image_url', image_url: { url: `data:${a.mimeType};base64,${a.base64}` } })),
    ]
  } else {
    userContent = promptWithDocs
  }

  // Convert Anthropic-style tool defs to OpenAI function tools.
  const oaTools = hasCustomTools
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
  const MAX_TURNS = 80

  for (let i = 0; i < MAX_TURNS; i++) {
    completion = await client.chat.completions.create({
      model: model || 'gpt-4o',
      max_tokens: 4096,
      messages,
      ...(oaTools ? { tools: oaTools } : {}),
    }, signal ? { signal } : undefined)
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
