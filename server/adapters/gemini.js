import { GoogleGenerativeAI } from '@google/generative-ai'

function composeSystem(systemPrompt = '', skills = []) {
  const parts = []
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  for (const s of skills || []) {
    if (s?.content?.trim()) parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }
  return parts.join('\n\n')
}

// Gemini only accepts a small OpenAPI subset for function parameters and rejects
// most JSON Schema keywords (const, exclusiveMinimum, additionalProperties, $ref,
// default, etc.). MCP tool schemas use the full spec, so we sanitize: drop the
// unsupported keywords, turn `const` into a single-value enum, and recurse into
// every nested schema (properties / items / anyOf / oneOf / allOf).
const DROP_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment', '$anchor', 'definitions',
  'additionalProperties', 'unevaluatedProperties', 'patternProperties', 'propertyNames',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'uniqueItems',
  'not', 'if', 'then', 'else', 'dependentSchemas', 'dependentRequired',
  'default', 'examples', 'readOnly', 'writeOnly', 'deprecated',
  'contentMediaType', 'contentEncoding',
])

function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out = {}
  for (const [k, v] of Object.entries(schema)) {
    if (DROP_KEYS.has(k)) continue
    if (k === 'const') {
      // Gemini has no `const` — express a string constant as a 1-value enum.
      if (typeof v === 'string') { out.enum = [v]; if (!out.type) out.type = 'string' }
      continue
    }
    if (k === 'properties' && v && typeof v === 'object') {
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

// Text + vision generation via Google Generative AI, with tool calling.
export async function run({ prompt, systemPrompt, skills, apiKey, model, media, attachments, tools, onToolCall }) {
  if (!apiKey) throw new Error('Gemini API key is not connected')

  const genAI = new GoogleGenerativeAI(apiKey)
  const system = composeSystem(systemPrompt, skills)
  const hasTools = Array.isArray(tools) && tools.length > 0 && typeof onToolCall === 'function'

  const generativeModel = genAI.getGenerativeModel({
    model: model || 'gemini-1.5-pro',
    ...(system ? { systemInstruction: system } : {}),
    ...(hasTools
      ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description || '', parameters: cleanSchema(t.input_schema) })) }] }
      : {}),
  })

  const parts = [{ text: prompt }]
  if (media?.base64 && media?.mimeType) parts.push({ inlineData: { mimeType: media.mimeType, data: media.base64 } })
  for (const a of attachments || []) {
    if (a.base64 && a.mimeType && (a.kind === 'image' || a.kind === 'pdf')) {
      parts.push({ inlineData: { mimeType: a.mimeType, data: a.base64 } })
    }
  }

  if (!hasTools) {
    const result = await generativeModel.generateContent(parts)
    return { ok: true, provider: 'gemini', type: 'text', content: result.response.text(), model: model || 'gemini-1.5-pro', usage: result.response.usageMetadata }
  }

  // Tool-calling loop.
  const chat = generativeModel.startChat()
  let lastMedia = null
  let result = await chat.sendMessage(parts)
  for (let i = 0; i < 8; i++) {
    const calls = (result.response.functionCalls && result.response.functionCalls()) || []
    if (!calls.length) break
    const responses = []
    for (const call of calls) {
      let content = ''
      try {
        let res = await onToolCall(call.name, call.args || {})
        if (typeof res === 'string') res = { content: res }
        content = res.content
        if (res.media) lastMedia = res.media
      } catch (e) {
        content = `Tool error: ${e.message}`
      }
      responses.push({ functionResponse: { name: call.name, response: { result: content } } })
    }
    result = await chat.sendMessage(responses)
  }

  return {
    ok: true,
    provider: 'gemini',
    type: lastMedia ? lastMedia.type : 'text',
    content: result.response.text(),
    model: model || 'gemini-1.5-pro',
    ...(lastMedia ? { media: lastMedia } : {}),
  }
}
