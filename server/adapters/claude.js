import Anthropic from '@anthropic-ai/sdk'

function composeSystem(systemPrompt = '', skills = []) {
  const parts = []
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  for (const s of skills || []) {
    if (s?.content?.trim()) parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }
  return parts.join('\n\n')
}

// Text generation via the Anthropic Messages API, with optional MCP tool use.
// { prompt, systemPrompt, skills, apiKey, model, tools?, onToolCall? }
//  - tools: Anthropic tool definitions [{ name, description, input_schema }]
//  - onToolCall(name, input) -> string : executes a tool (e.g. an MCP call)
// Returns a normalized { ok, provider, type, content, toolCalls? }.
export async function run({ prompt, systemPrompt, skills, apiKey, model, tools, onToolCall }) {
  if (!apiKey) throw new Error('Anthropic API key is not connected')

  const client = new Anthropic({ apiKey })
  const system = composeSystem(systemPrompt, skills)
  const hasTools = Array.isArray(tools) && tools.length > 0 && typeof onToolCall === 'function'

  const messages = [{ role: 'user', content: prompt }]
  const toolCalls = []
  let response
  const MAX_TURNS = 6

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    response = await client.messages.create({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 8192,
      ...(system ? { system } : {}),
      ...(hasTools ? { tools } : {}),
      messages,
    })

    if (response.stop_reason !== 'tool_use') break

    // Execute each requested tool and feed results back.
    messages.push({ role: 'assistant', content: response.content })
    const results = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      toolCalls.push({ name: block.name, input: block.input })
      let output
      let isError = false
      try {
        output = await onToolCall(block.name, block.input)
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
