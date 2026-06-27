import OpenAI from 'openai'

// Groq serves open models (Llama 4 Scout, Llama 3.3, DeepSeek R1 distill, Gemma2,
// Qwen3, …) on its LPU hardware with very high-speed inference. Its API is
// OpenAI-compatible, so we reuse the OpenAI SDK pointed at Groq's base URL.
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'

function composeSystem(systemPrompt = '', skills = []) {
  const parts = []
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  for (const s of skills || []) {
    if (s?.content?.trim()) parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }
  return parts.join('\n\n')
}

// DeepSeek-R1 (and other reasoning models) wrap their chain-of-thought in
// <think>…</think>. Strip it so the chat shows only the final answer.
function stripReasoning(text = '') {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim() || text.trim()
}

// Groq's open models do grammar-constrained tool-call generation that's far
// pickier than GPT-4o: large/complex MCP schemas (const, $ref, additionalProps,
// deep nesting, huge descriptions) make it emit invalid JSON -> 400 "Failed to
// call a function". So we strip unsupported JSON-Schema keywords and trim long
// descriptions before sending tools, the same idea as the Gemini adapter.
const DROP_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment', '$anchor', 'definitions',
  'additionalProperties', 'unevaluatedProperties', 'patternProperties', 'propertyNames',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'uniqueItems',
  'not', 'if', 'then', 'else', 'dependentSchemas', 'dependentRequired',
  'default', 'examples', 'readOnly', 'writeOnly', 'deprecated',
  'contentMediaType', 'contentEncoding', 'format',
])

function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    if (DROP_KEYS.has(k)) continue
    if (k === 'const') {
      if (typeof v === 'string') { out.enum = [v]; if (!out.type) out.type = 'string' }
      continue
    }
    if (k === 'description' && typeof v === 'string') {
      out.description = v.length > 300 ? v.slice(0, 297) + '…' : v
    } else if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, cleanSchema(pv)]))
    } else if (k === 'items') {
      out.items = cleanSchema(v)
    } else if ((k === 'anyOf' || k === 'oneOf' || k === 'allOf') && Array.isArray(v)) {
      out[k] = v.map(cleanSchema)
    } else {
      out[k] = v
    }
  }
  if (!out.type && !out.anyOf && !out.oneOf && !out.allOf && !out.enum) out.type = 'object'
  return out
}

// Turn Groq's verbose errors into short, actionable messages.
function friendlyError(err) {
  const raw = String(err?.message || err || '')
  if (/\b429\b|too many requests|rate.?limit/i.test(raw)) {
    const retry = raw.match(/try again in ([\d.]+)s/i)?.[1]
    return new Error(
      `Groq rate limit hit${retry ? ` — retry in ~${Math.ceil(Number(retry))}s` : ''}. ` +
      'The free tier allows 30 requests/minute; wait a moment and resend.'
    )
  }
  if (/\b401\b|invalid.?api.?key|unauthorized/i.test(raw)) {
    return new Error('Groq rejected the API key. Get a fresh one at console.groq.com → API Keys and re-paste it.')
  }
  if (/\b404\b|does not exist|decommissioned|model_not_found/i.test(raw)) {
    return new Error('That Groq model is unavailable or was retired. Pick another model — Groq rotates its lineup occasionally.')
  }
  if (/tool|function.?call/i.test(raw) && /not support|unsupported/i.test(raw)) {
    return new Error('This Groq model does not support tool calling. Disable MCP tools or switch to Llama 3.3 70B for tools.')
  }
  // Groq's constrained tool-call decoder produced invalid arguments. Common with
  // large multi-tool MCP setups (e.g. Higgsfield) on the smaller open models.
  if (/failed to call a function|failed_generation/i.test(raw)) {
    return new Error(
      "This Groq model couldn't format the tool call (Groq's open models are weaker at " +
      'complex multi-tool flows like Higgsfield). Switch Model A to Claude or GPT-4o for ' +
      'agentic / tool-heavy tasks, and keep Groq for fast plain chat.'
    )
  }
  return err instanceof Error ? err : new Error(raw)
}

// Text + vision generation via Groq (OpenAI-compatible), with image attachments
// and tool calling. Only multimodal models (e.g. Llama 4 Scout) accept images.
// { prompt, systemPrompt, skills, apiKey, model, attachments, tools?, onToolCall? }
export async function run(opts) {
  try {
    return await runInner(opts)
  } catch (err) {
    throw friendlyError(err)
  }
}

async function runInner({ prompt, systemPrompt, skills, apiKey, model, attachments, tools, onToolCall }) {
  if (!apiKey) throw new Error('Groq API key is not connected')

  const client = new OpenAI({ apiKey, baseURL: GROQ_BASE_URL })
  const system = composeSystem(systemPrompt, skills)
  const apiModel = model || 'llama-3.3-70b-versatile'

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

  // Convert Anthropic-style tool defs to OpenAI/Groq function tools.
  const hasTools = Array.isArray(tools) && tools.length > 0 && typeof onToolCall === 'function'
  const oaTools = hasTools
    ? tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: (t.description || '').slice(0, 300),
          parameters: cleanSchema(t.input_schema || { type: 'object', properties: {} }),
        },
      }))
    : undefined

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: userContent })

  let completion
  const MAX_TURNS = 8

  for (let i = 0; i < MAX_TURNS; i++) {
    completion = await client.chat.completions.create({
      model: apiModel,
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
      } catch (e) {
        content = `Tool error: ${e.message}`
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(content ?? '') })
    }
  }

  return {
    ok: true,
    provider: 'groq',
    type: 'text',
    content: stripReasoning(completion.choices?.[0]?.message?.content || ''),
    model: completion.model,
    usage: completion.usage,
  }
}
