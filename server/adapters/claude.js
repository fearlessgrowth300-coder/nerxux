import Anthropic from '@anthropic-ai/sdk'

function composeSystem(systemPrompt = '', skills = []) {
  const parts = []
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  for (const s of skills || []) {
    if (s?.content?.trim()) parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }
  return parts.join('\n\n')
}

// Builds the first user message content: any image/PDF attachments + the text.
function buildUserContent(prompt, attachments = []) {
  const content = []
  for (const a of attachments) {
    if (a.kind === 'image' && a.base64) {
      content.push({ type: 'image', source: { type: 'base64', media_type: a.mimeType, data: a.base64 } })
    } else if (a.kind === 'pdf' && a.base64) {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.base64 } })
    }
  }
  content.push({ type: 'text', text: prompt })
  return content.length === 1 ? prompt : content
}

// Text generation via the Anthropic Messages API, with optional image/PDF
// attachments, web search, and MCP tool use.
// { prompt, systemPrompt, skills, apiKey, model, tools?, onToolCall?, attachments?, webSearch? }
export async function run({
  prompt, systemPrompt, skills, apiKey, model, tools, onToolCall, attachments, webSearch,
}) {
  if (!apiKey) throw new Error('Anthropic API key is not connected')

  const client = new Anthropic({ apiKey })
  const system = composeSystem(systemPrompt, skills)

  const allTools = []
  if (Array.isArray(tools)) allTools.push(...tools)
  if (webSearch) allTools.push({ type: 'web_search_20260209', name: 'web_search' })
  const hasCustomTools = Array.isArray(tools) && tools.length > 0 && typeof onToolCall === 'function'

  const messages = [{ role: 'user', content: buildUserContent(prompt, attachments) }]
  const toolCalls = []
  let response
  const MAX_TURNS = 8

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    response = await client.messages.create({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 8192,
      ...(system ? { system } : {}),
      ...(allTools.length ? { tools: allTools } : {}),
      messages,
    })

    // Server-side tools (web search) may pause; resend to continue.
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content })
      continue
    }

    if (response.stop_reason !== 'tool_use') break

    // Custom (MCP) tool calls — execute and feed results back.
    messages.push({ role: 'assistant', content: response.content })
    const results = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      toolCalls.push({ name: block.name, input: block.input })
      let output
      let isError = false
      try {
        output = hasCustomTools ? await onToolCall(block.name, block.input) : 'Tool not available'
      } catch (e) {
        output = `Tool error: ${e.message}`
        isError = true
      }
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: String(output ?? ''),
        ...(isError ? { is_error: true } : {}),
      })
    }
    messages.push({ role: 'user', content: results })
  }

  const content = (response?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')

  return {
    ok: true,
    provider: 'claude',
    type: 'text',
    content,
    model: response?.model,
    usage: response?.usage,
    ...(toolCalls.length ? { toolCalls } : {}),
  }
}
