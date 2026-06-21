import Anthropic from '@anthropic-ai/sdk'

function composeSystem(systemPrompt = '', skills = []) {
  const parts = []
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  for (const s of skills || []) {
    if (s?.content?.trim()) parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }
  return parts.join('\n\n')
}

function buildUserContent(prompt, attachments = []) {
  const content = []
  for (const a of attachments) {
    if (a.kind === 'image' && a.base64) content.push({ type: 'image', source: { type: 'base64', media_type: a.mimeType, data: a.base64 } })
    else if (a.kind === 'pdf' && a.base64) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.base64 } })
  }
  content.push({ type: 'text', text: prompt })
  return content.length === 1 ? prompt : content
}

function finalText(response) {
  return (response?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
}

// Text generation via Anthropic Messages API, with image/PDF attachments, web
// search, and MCP tool use that can pause for per-tool approval.
//
// { prompt, systemPrompt, skills, apiKey, model, tools?, onToolCall?, attachments?,
//   webSearch?, permissionFor?, resume? }
//
// `permissionFor(name)` -> 'allow' | 'approval'. When a requested tool needs
// approval, returns { ok, pending:true, pendingTools, resumeState }.
// `resume` = { messages, results } continues a paused run.
export async function run({
  prompt, systemPrompt, skills, apiKey, model, tools, onToolCall, attachments,
  webSearch, permissionFor, resume,
}) {
  if (!apiKey) throw new Error('Anthropic API key is not connected')

  const client = new Anthropic({ apiKey })
  const system = composeSystem(systemPrompt, skills)
  const perm = typeof permissionFor === 'function' ? permissionFor : () => 'allow'

  const allTools = []
  if (Array.isArray(tools)) allTools.push(...tools)
  if (webSearch) allTools.push({ type: 'web_search_20260209', name: 'web_search' })
  const hasCustomTools = Array.isArray(tools) && tools.length > 0 && typeof onToolCall === 'function'

  // Build or restore the message history.
  const messages = resume ? [...resume.messages] : [{ role: 'user', content: buildUserContent(prompt, attachments) }]
  if (resume) messages.push({ role: 'user', content: resume.results })

  const toolCalls = []
  let lastMedia = resume?.media || null
  let response
  const MAX_TURNS = 10

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    response = await client.messages.create({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 8192,
      ...(system ? { system } : {}),
      ...(allTools.length ? { tools: allTools } : {}),
      messages,
    })

    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content })
      continue
    }
    if (response.stop_reason !== 'tool_use') break

    messages.push({ role: 'assistant', content: response.content })

    const autoResults = []
    const pendingTools = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      if (perm(block.name) === 'approval') {
        pendingTools.push({ id: block.id, name: block.name, input: block.input })
        continue
      }
      toolCalls.push({ name: block.name, input: block.input })
      let output = '', isError = false
      try {
        let res = hasCustomTools ? await onToolCall(block.name, block.input) : { content: 'Tool not available' }
        if (typeof res === 'string') res = { content: res }
        output = res.content
        if (res.media) lastMedia = res.media
      } catch (e) {
        output = `Tool error: ${e.message}`
        isError = true
      }
      autoResults.push({ type: 'tool_result', tool_use_id: block.id, content: String(output ?? ''), ...(isError ? { is_error: true } : {}) })
    }

    // Some tools require approval — pause and hand state back to the caller.
    if (pendingTools.length) {
      return {
        ok: true,
        pending: true,
        pendingTools,
        resumeState: { messages, autoResults, media: lastMedia },
        provider: 'claude',
      }
    }

    messages.push({ role: 'user', content: autoResults })
  }

  return {
    ok: true,
    provider: 'claude',
    type: lastMedia ? lastMedia.type : 'text',
    content: finalText(response),
    model: response?.model,
    usage: response?.usage,
    ...(lastMedia ? { media: lastMedia, mediaType: lastMedia.type } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
  }
}
