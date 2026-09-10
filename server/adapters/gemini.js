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

// The SDK THROWS from functionCalls()/text() when a response has no usable
// candidate, so one blocked reply took down the whole turn — including any text
// the model did produce. Read them defensively and decide what to say ourselves.
function safeFunctionCalls(response) {
  try {
    return response.functionCalls?.() || []
  } catch {
    return []
  }
}

function safeText(response) {
  try {
    return response.text() || ''
  } catch {
    return ''
  }
}

// "Response was blocked due to OTHER" tells the user nothing they can act on.
function blockedMessage(response, modelName, hasTools) {
  const candidate = response?.candidates?.[0]
  const reason = response?.promptFeedback?.blockReason || candidate?.finishReason || 'UNKNOWN'
  if (/SAFETY/i.test(reason)) {
    return `${modelName} blocked this response on its safety filters. Rephrase the request, or use a different model.`
  }
  if (/RECITATION/i.test(reason)) {
    return `${modelName} stopped because the answer was reproducing training data verbatim. Ask for it in your own words.`
  }
  if (/MAX_TOKENS/i.test(reason)) {
    return `${modelName} hit its output limit before saying anything usable. Ask for a shorter answer.`
  }
  return (
    `${modelName} returned an empty response (reason: ${reason})` +
    (hasTools
      ? '. This usually means the model refused the request while tools were attached — try turning off connectors for this chat, or switch to Claude or GPT for tool-heavy work.'
      : '. Try again, or switch models.')
  )
}

// Turn Google's verbose SDK errors into a short, actionable message.
function friendlyError(err) {
  const raw = String(err?.message || err || '')
  const is429 = /\b429\b|too many requests|resource_exhausted/i.test(raw)
  const isQuota = /quota|rate.?limit|exceeded/i.test(raw)
  if (is429 || isQuota) {
    // limit: 0 => the key's project has no free-tier allowance at all (geo-locked
    // or a Cloud-Console key); retrying never helps, billing/new key does.
    if (/limit:\s*0\b/.test(raw)) {
      return new Error(
        'Gemini quota is 0 for this API key — the free tier is not enabled for its project. ' +
        'Create a new key at aistudio.google.com/apikey ("Create API key in new project"), ' +
        'or if that still shows 0, enable billing on the project (free tier may be unavailable in your region).'
      )
    }
    // Google returns a short retryDelay even when the exhausted quota is a
    // DAILY one, so "retry in ~12s" sends people round in circles for the rest
    // of the day. Say which quota actually ran out.
    const perDay = /PerDay|generate_content_free_tier_requests/i.test(raw)
    const limit = raw.match(/limit:\s*(\d+)/)?.[1]
    const model = raw.match(/models\/([\w.-]+):/)?.[1] || raw.match(/model:\s*([\w.-]+)/)?.[1]
    if (perDay) {
      return new Error(
        `Gemini's free daily limit${limit ? ` of ${limit} requests` : ''}${model ? ` for ${model}` : ''} is used up for today. ` +
        'It resets at midnight Pacific time. To keep going now, pick a different model or enable billing at aistudio.google.com/apikey.'
      )
    }
    const retry = raw.match(/retry in ([\d.]+)s/i)?.[1]
    return new Error(
      `Gemini rate limit hit${retry ? ` — retry in ~${Math.ceil(Number(retry))}s` : ''}. ` +
      'You are sending requests faster than your plan allows; wait a moment or enable billing for higher limits.'
    )
  }
  if (/api.?key|invalid|unauthorized|permission|401|403/i.test(raw)) {
    return new Error('Gemini rejected the API key (invalid or lacking access). Re-paste a fresh key from aistudio.google.com/apikey.')
  }
  return err instanceof Error ? err : new Error(raw)
}

// Text + vision generation via Google Generative AI, with tool calling.
export async function run(opts) {
  try {
    return await runInner(opts)
  } catch (err) {
    throw friendlyError(err)
  }
}

async function runInner({ prompt, systemPrompt, skills, apiKey, model, media, attachments, tools, onToolCall, webSearch }) {
  if (!apiKey) throw new Error('Gemini API key is not connected')

  const genAI = new GoogleGenerativeAI(apiKey)
  const system = composeSystem(systemPrompt, skills)
  const hasTools = Array.isArray(tools) && tools.length > 0 && typeof onToolCall === 'function'
  const modelName = model || 'gemini-1.5-pro'
  // Native "grounding" — Gemini itself runs the search and cites real sources,
  // no scraping/API key of ours needed. Skipped when MCP/native tools are also
  // active: Gemini rejects mixing its built-in search tool with custom
  // function-calling tools in the same request.
  const searchTool = webSearch && !hasTools
    ? (/^gemini-(2|3)/.test(modelName) ? { googleSearch: {} } : { googleSearchRetrieval: { dynamicRetrievalConfig: { mode: 'MODE_DYNAMIC', dynamicThreshold: 0.3 } } })
    : null

  const generativeModel = genAI.getGenerativeModel({
    model: modelName,
    ...(system ? { systemInstruction: system } : {}),
    ...(hasTools
      ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description || '', parameters: cleanSchema(t.input_schema) })) }] }
      : searchTool
        ? { tools: [searchTool] }
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
    let content = safeText(result.response)
    if (!content) throw new Error(blockedMessage(result.response, modelName, false))
    // Surface the real pages Gemini grounded on, so search answers are
    // checkable instead of a bare claim.
    const chunks = result.response.candidates?.[0]?.groundingMetadata?.groundingChunks || []
    const sources = chunks.map((c) => c.web).filter((w) => w?.uri)
    if (sources.length) {
      content += '\n\n**Sources:**\n' + sources.map((s) => `- [${s.title || s.uri}](${s.uri})`).join('\n')
    }
    return { ok: true, provider: 'gemini', type: 'text', content, model: modelName, usage: result.response.usageMetadata }
  }

  // Tool-calling loop.
  const chat = generativeModel.startChat()
  let lastMedia = null
  const mediaAll = [] // every generated image/video this turn, not just the last
  let result = await chat.sendMessage(parts)
  for (let i = 0; i < 40; i++) {
    const calls = safeFunctionCalls(result.response)
    if (!calls.length) break
    const responses = []
    for (const call of calls) {
      let content = ''
      try {
        let res = await onToolCall(call.name, call.args || {})
        if (typeof res === 'string') res = { content: res }
        content = res.content
        if (res.media) lastMedia = res.media
        for (const m of res.mediaList?.length ? res.mediaList : res.media ? [res.media] : []) mediaAll.push(m)
      } catch (e) {
        content = `Tool error: ${e.message}`
      }
      responses.push({ functionResponse: { name: call.name, response: { result: content } } })
    }
    result = await chat.sendMessage(responses)
  }

  const content = safeText(result.response)
  // Nothing usable came back at all — explain why rather than letting the SDK's
  // "Function call not available. Response was blocked due to OTHER" surface.
  if (!content && !lastMedia) throw new Error(blockedMessage(result.response, modelName, true))
  return {
    ok: true,
    provider: 'gemini',
    type: lastMedia ? lastMedia.type : 'text',
    content,
    model: modelName,
    ...(lastMedia ? { media: lastMedia, mediaList: mediaAll } : {}),
  }
}


// Exported for tests only.
export { friendlyError as _friendlyError, blockedMessage as _blockedMessage, safeFunctionCalls as _safeFunctionCalls, safeText as _safeText }
