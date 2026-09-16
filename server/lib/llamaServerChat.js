// Always On can run on llama-server (llama.cpp) instead of Ollama. llama-server
// has no Ollama /api/chat — only the OpenAI-style /v1/chat/completions — so this
// translates one Ollama chat request into an OpenAI one and turns the reply back
// into the Ollama NDJSON stream the adapter already reads (readChatResponse).
// The adapter's loop, time budgets, tool handling and read-speed learning stay
// exactly as they are.
//
// Turn it on with ALWAYS_ON_API=openai; HOSTINGER_OLLAMA_URL then points at the
// llama-server (e.g. http://127.0.0.1:8080). Turbo keeps talking to Ollama.

import { Agent } from 'undici'

// Same reasoning as OLLAMA_DISPATCHER: nothing comes back while a long prompt
// is read on the CPU, and Node's default header timeout would call that a
// connection failure.
const DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

export const alwaysOnUsesOpenAI = () => String(process.env.ALWAYS_ON_API || '').toLowerCase() === 'openai'

// ---------- request: Ollama -> OpenAI ----------

// Ollama tool calls carry no ids and their arguments are objects; OpenAI (and
// llama-server's chat template) need string arguments and a tool_call_id on
// every tool result. Ids are assigned in order and results are matched to the
// open calls of the assistant message before them, which is how the adapter
// pushes them (one result per call, same order).
export function toOpenAIMessages(messages = []) {
  const out = []
  let pending = [] // ids of the latest assistant tool calls not yet answered
  let n = 0
  for (const m of messages) {
    if (!m || !m.role) continue
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : []
      const toolCalls = calls
        .filter((tc) => tc?.function?.name)
        .map((tc) => {
          const id = tc.id || `call_${++n}`
          const args = tc.function.arguments
          return { id, type: 'function', function: { name: tc.function.name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) } }
        })
      pending = toolCalls.map((tc) => tc.id)
      out.push({ role: 'assistant', content: m.content || '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
      continue
    }
    if (m.role === 'tool') {
      const id = pending.shift()
      // A result whose call was trimmed away can't be linked; keep it as plain data.
      if (!id) { out.push({ role: 'user', content: `[Earlier tool observation${m.tool_name ? `: ${m.tool_name}` : ''}] ${m.content || ''}` }); continue }
      out.push({ role: 'tool', tool_call_id: id, content: String(m.content ?? '') })
      continue
    }
    pending = []
    let content = String(m.content ?? '')
    // No vision projector is loaded on Always On. Say so instead of failing the request.
    if (Array.isArray(m.images) && m.images.length) {
      content += `\n\n[${m.images.length} attached image${m.images.length === 1 ? ' was' : 's were'} not included: the Always On model cannot see images. Switch to Turbo for image questions.]`
    }
    out.push({ role: m.role, content })
  }
  return out
}

export function toOpenAIRequest(body = {}) {
  const opts = body.options || {}
  return {
    model: body.model,
    messages: toOpenAIMessages(body.messages),
    ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}),
    stream: body.stream !== false,
    ...(body.stream !== false ? { stream_options: { include_usage: true } } : {}),
    ...(Number(opts.num_predict) > 0 ? { max_tokens: Number(opts.num_predict) } : {}),
    // Reuse the matching start of the previous request (the adapter keeps it stable).
    cache_prompt: true,
  }
}

// ---------- response: OpenAI -> Ollama ----------

const doneReason = (finish) => (finish === 'length' ? 'length' : 'stop')

// Ollama reports durations in nanoseconds; llama-server's `timings` in ms.
function usageFields(timings, usage) {
  const f = {}
  const promptN = timings?.prompt_n ?? usage?.prompt_tokens
  const genN = timings?.predicted_n ?? usage?.completion_tokens
  if (Number.isFinite(promptN)) f.prompt_eval_count = promptN
  if (Number.isFinite(timings?.prompt_ms)) f.prompt_eval_duration = Math.round(timings.prompt_ms * 1e6)
  if (Number.isFinite(genN)) f.eval_count = genN
  if (Number.isFinite(timings?.predicted_ms)) f.eval_duration = Math.round(timings.predicted_ms * 1e6)
  return f
}

// Parsed arguments, or null when the model's JSON is broken.
function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  const s = String(raw ?? '').trim()
  if (!s) return {}
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : { value: v } } catch { return null }
}

// The adapter's retry path for a cut-off tool call keys on this wording
// (MALFORMED_TOOL_CALL in adapters/ollama.js).
const BAD_CALL = 'failed to parse tool call arguments'

function toolCallsOut(list) {
  const calls = []
  for (const tc of list) {
    if (!tc?.function?.name) continue
    const args = parseArgs(tc.function.arguments)
    if (args === null) return { error: `${BAD_CALL} for ${tc.function.name}` }
    calls.push({ function: { name: tc.function.name, arguments: args } })
  }
  return { calls }
}

// Non-streaming OpenAI reply -> one Ollama /api/chat JSON object.
export function fromOpenAIJson(j) {
  if (j?.error) return { error: j.error }
  const choice = j?.choices?.[0] || {}
  const m = choice.message || {}
  const tc = toolCallsOut(Array.isArray(m.tool_calls) ? m.tool_calls : [])
  if (tc.error) return { error: tc.error }
  return {
    model: j.model,
    message: {
      role: 'assistant',
      content: m.content || '',
      ...(m.reasoning_content ? { thinking: m.reasoning_content } : {}),
      ...(tc.calls.length ? { tool_calls: tc.calls } : {}),
    },
    done: true,
    done_reason: doneReason(choice.finish_reason),
    ...usageFields(j.timings, j.usage),
  }
}

// Server-sent events from /v1/chat/completions -> Ollama NDJSON lines.
// Text and thinking are passed through as they arrive; tool calls arrive in
// fragments and are emitted whole in the final line.
export function sseToOllamaStream(body) {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  return new ReadableStream({
    async start(controller) {
      const reader = body.getReader()
      const emit = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
      const calls = [] // by index: { function: { name, arguments } }
      let finish = null
      let timings = null
      let usage = null
      let model
      let buf = ''
      let ended = false
      const handle = (data) => {
        if (data === '[DONE]') { ended = true; return }
        let j
        try { j = JSON.parse(data) } catch { return }
        if (j.error) { emit({ error: j.error }); ended = true; return }
        model = j.model || model
        if (j.timings) timings = j.timings
        if (j.usage) usage = j.usage
        const choice = j.choices?.[0]
        if (!choice) return
        const d = choice.delta || {}
        if (d.content) emit({ model, message: { role: 'assistant', content: d.content }, done: false })
        if (d.reasoning_content) emit({ model, message: { role: 'assistant', content: '', thinking: d.reasoning_content }, done: false })
        for (const part of d.tool_calls || []) {
          const i = Number.isInteger(part.index) ? part.index : calls.length
          const c = calls[i] || (calls[i] = { function: { name: '', arguments: '' } })
          if (part.function?.name) c.function.name += part.function.name
          if (part.function?.arguments) c.function.arguments += part.function.arguments
        }
        if (choice.finish_reason) finish = choice.finish_reason
      }
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop()
          for (const raw of lines) {
            const line = raw.trim()
            if (line.startsWith('data:')) handle(line.slice(5).trim())
            if (ended) break
          }
          if (ended) break
        }
        const rest = (buf + decoder.decode()).trim()
        if (!ended && rest.startsWith('data:')) handle(rest.slice(5).trim())
        const tc = toolCallsOut(calls.filter(Boolean))
        if (tc.error) emit({ error: tc.error })
        else {
          emit({
            model,
            message: { role: 'assistant', content: '', ...(tc.calls.length ? { tool_calls: tc.calls } : {}) },
            done: true,
            done_reason: doneReason(finish),
            ...usageFields(timings, usage),
          })
        }
        controller.close()
      } catch (e) {
        reader.cancel().catch(() => {})
        controller.error(e)
      }
    },
  })
}

// POST an Ollama-shaped chat body to llama-server and return a fetch Response
// shaped like Ollama's: NDJSON when streaming, one JSON object otherwise, and
// Ollama-style { error } bodies on failure.
export async function postOpenAIChat(baseUrl, body, { signal, fetchImpl = fetch } = {}) {
  const resp = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    dispatcher: DISPATCHER,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toOpenAIRequest(body)),
    signal,
  })
  const headers = { 'Content-Type': 'application/x-ndjson' }
  if (!resp.ok) {
    let err = `llama-server returned ${resp.status}`
    try { const j = await resp.json(); if (j?.error) err = j.error?.message || j.error } catch {}
    return new Response(JSON.stringify({ error: err }), { status: resp.status, headers })
  }
  if (body.stream === false) {
    return new Response(JSON.stringify(fromOpenAIJson(await resp.json())), { status: 200, headers })
  }
  return new Response(sseToOllamaStream(resp.body), { status: 200, headers })
}

// Reachability + model names, in the shape health() collects.
export async function openAIModels(baseUrl, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json()
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean)
}
