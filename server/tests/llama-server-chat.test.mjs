import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { toOpenAIMessages, toOpenAIRequest, fromOpenAIJson, postOpenAIChat, openAIModels } from '../lib/llamaServerChat.js'
import { readChatResponse } from '../adapters/ollama.js'

// Shapes below are what llama-server (llama.cpp 4df29be4, --jinja,
// --reasoning-format deepseek) returned on the VPS on 2026-09-16.

const sse = (events) => new Response(new ReadableStream({
  start(c) {
    const enc = new TextEncoder()
    // Split mid-line on purpose: network chunks don't respect event boundaries.
    const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
    const mid = Math.floor(text.length / 2)
    c.enqueue(enc.encode(text.slice(0, mid)))
    c.enqueue(enc.encode(text.slice(mid)))
    c.close()
  },
}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

const delta = (d, extra = {}) => ({ model: 'm', choices: [{ index: 0, delta: d, finish_reason: null }], ...extra })

test('Ollama messages become OpenAI messages with linked tool calls', () => {
  const out = toOpenAIMessages([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'fix it', images: ['abc'] },
    { role: 'assistant', content: '', tool_calls: [
      { function: { name: 'read_file', arguments: { path: 'a.py' } } },
      { function: { name: 'run', arguments: { cmd: 'pytest' } } },
    ] },
    { role: 'tool', tool_name: 'read_file', content: 'print(1)' },
    { role: 'tool', tool_name: 'run', content: '1 passed' },
    { role: 'tool', tool_name: 'orphan', content: 'left over' },
  ])
  assert.equal(out[0].role, 'system')
  assert.match(out[1].content, /no vision support/, 'images are dropped with a note, not sent to a server without vision')
  assert.equal(out[1].images, undefined)
  const calls = out[2].tool_calls
  assert.equal(calls.length, 2)
  assert.equal(calls[0].type, 'function')
  assert.equal(typeof calls[0].function.arguments, 'string', 'OpenAI wants string arguments')
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'a.py' })
  assert.equal(out[3].role, 'tool')
  assert.equal(out[3].tool_call_id, calls[0].id, 'first result answers the first call')
  assert.equal(out[4].tool_call_id, calls[1].id)
  assert.equal(out[5].role, 'user', 'a result with no open call is kept as data')
  assert.match(out[5].content, /Earlier tool observation: orphan/)
})

test('the request maps num_predict, keeps tools and asks for usage', () => {
  const r = toOpenAIRequest({ model: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 't' } }], stream: true, options: { num_predict: 3000, num_ctx: 32768 } })
  assert.equal(r.max_tokens, 3000)
  assert.equal(r.stream, true)
  assert.deepEqual(r.stream_options, { include_usage: true })
  assert.equal(r.cache_prompt, true)
  assert.equal(r.tools.length, 1)
  assert.equal(r.options, undefined)
})

test('a streamed reply reads back exactly like Ollama: text, thinking, tool calls, timings', async () => {
  const fetchImpl = async (url, init) => {
    assert.match(url, /\/v1\/chat\/completions$/)
    assert.equal(JSON.parse(init.body).stream, true)
    return sse([
      delta({ role: 'assistant', content: null }),
      delta({ reasoning_content: 'Need call get_time ' }),
      delta({ reasoning_content: 'city Lagos.' }),
      delta({ content: 'Checking.' }),
      delta({ tool_calls: [{ index: 0, id: 'x1', type: 'function', function: { name: 'get_time', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"Lagos"}' } }] }),
      { model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], timings: { prompt_n: 316, prompt_ms: 45000, predicted_n: 80, predicted_ms: 21500 } },
      { model: 'm', choices: [], usage: { prompt_tokens: 316, completion_tokens: 80 } },
      '[DONE]',
    ])
  }
  const resp = await postOpenAIChat('http://127.0.0.1:8080', { model: 'm', messages: [{ role: 'user', content: 'time?' }], stream: true, options: { num_predict: 100 } }, { fetchImpl })
  const seen = []
  const data = await readChatResponse(resp, (c) => seen.push(c))
  assert.equal(data.error, undefined)
  assert.equal(data.message.content, 'Checking.')
  assert.equal(data.message.thinking, 'Need call get_time city Lagos.')
  assert.deepEqual(data.message.tool_calls, [{ function: { name: 'get_time', arguments: { city: 'Lagos' } } }], 'arguments are an object, as the loop expects')
  assert.equal(data.done_reason, 'stop')
  assert.equal(data.prompt_eval_count, 316)
  assert.equal(data.prompt_eval_duration, 45000 * 1e6, 'nanoseconds, like Ollama, so read-speed learning works')
  assert.equal(data.eval_count, 80)
  assert.ok(seen.some((c) => c.thinking) && seen.at(-1).content === 'Checking.', 'live progress sees thinking and text as they stream')
})

test('a reply cut by max_tokens reports done_reason length', async () => {
  const fetchImpl = async () => sse([delta({ content: 'partial' }), { model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }, '[DONE]'])
  const data = await readChatResponse(await postOpenAIChat('u', { messages: [], stream: true }, { fetchImpl }))
  assert.equal(data.done_reason, 'length')
})

test('broken tool-call JSON becomes the error the adapter retries on', async () => {
  const fetchImpl = async () => sse([
    delta({ tool_calls: [{ index: 0, function: { name: 'write_file', arguments: '{"path":"a.py","content":"unterminated' } }] }),
    { model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
    '[DONE]',
  ])
  const data = await readChatResponse(await postOpenAIChat('u', { messages: [], stream: true }, { fetchImpl }))
  const MALFORMED_TOOL_CALL = /XML syntax error|unexpected end element|invalid character|unmarshal|failed to parse tool/i
  assert.ok(data.error, 'an unusable call must not be run with empty arguments')
  assert.match(String(data.error), MALFORMED_TOOL_CALL)
})

test('non-streaming replies and server errors keep the Ollama shape', async () => {
  const ok = await postOpenAIChat('u', { messages: [], stream: false }, {
    fetchImpl: async () => new Response(JSON.stringify({ model: 'm', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done: wrote a.py', reasoning_content: 'think' } }], timings: { prompt_n: 900, prompt_ms: 90000 } }), { status: 200 }),
  })
  const j = await ok.json()
  assert.equal(j.message.content, 'Done: wrote a.py')
  assert.equal(j.message.thinking, 'think')
  assert.equal(j.prompt_eval_count, 900)

  const bad = await postOpenAIChat('u', { messages: [], stream: true }, {
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 400, message: 'the request exceeds the available context size', type: 'exceed_context_size_error' } }), { status: 400 }),
  })
  assert.equal(bad.ok, false)
  assert.equal((await bad.json()).error, 'the request exceeds the available context size')

  assert.deepEqual(fromOpenAIJson({ error: 'x' }), { error: 'x' })
})

test('health lists llama-server models', async () => {
  const names = await openAIModels('u', { fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'qwen-27b.gguf' }] }), { status: 200 }) })
  assert.deepEqual(names, ['qwen-27b.gguf'])
})

test('the adapter routes Always On through llama-server only when ALWAYS_ON_API=openai, never Turbo', async () => {
  const src = await fs.readFile('./adapters/ollama.js', 'utf8')
  // Kaggle and Always On are separate branches now: only Kaggle can carry a
  // vision projector, so only it passes a vision flag. Always On stays
  // text-only, and Turbo must never reach postOpenAIChat at all.
  assert.match(src, /if \(isKaggleUrl\(targetUrl\)\) return postOpenAIChat\(targetUrl, body, \{ signal, vision: getKaggleVision\(\) \}\)/)
  assert.match(src, /if \(!isRunpod && alwaysOnUsesOpenAI\(\)\) return postOpenAIChat\(targetUrl, body, \{ signal \}\)/)
  assert.equal((src.match(/fetch\(`\$\{targetUrl\}\/api\/chat`/g) || []).length, 1, 'every chat request goes through postChat')
  assert.equal((src.match(/await postChat\(targetUrl,/g) || []).length, 2, 'the step request and the wrap-up both use it')
})

// Vision is end-to-end or it is nothing: the Kaggle notebook loading an mmproj
// achieves exactly zero on its own, because this translation layer used to
// strip every image and replace it with a note before the request ever left
// the VPS (caught 2026-09-17 while wiring the projector up).
test('images are SENT when the server has a projector, and described when it does not', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUg'
  const msgs = [{ role: 'user', content: 'what is this?', images: [png] }]

  const withVision = toOpenAIMessages(msgs, { vision: true })
  assert.ok(Array.isArray(withVision[0].content), 'a vision request must use OpenAI multimodal content parts')
  const parts = withVision[0].content
  assert.deepEqual(parts[0], { type: 'text', text: 'what is this?' })
  assert.equal(parts[1].type, 'image_url')
  assert.match(parts[1].image_url.url, /^data:image\/png;base64,iVBORw0KGgo/)
  assert.doesNotMatch(JSON.stringify(withVision), /not included/, 'the image is sent, so nothing is described away')

  const noVision = toOpenAIMessages(msgs, { vision: false })
  assert.equal(typeof noVision[0].content, 'string', 'a text-only server must not be sent image parts — it rejects the whole request')
  assert.match(noVision[0].content, /1 attached image was not included/)
  // Must not name a backend: this path serves Always On AND a Kaggle run whose
  // notebook found no projector.
  assert.doesNotMatch(noVision[0].content, /Always On model/)
})

test('vision defaults to OFF, so an unknown server is never sent images it cannot decode', () => {
  const msgs = [{ role: 'user', content: 'hi', images: ['iVBORw0KGgoAAAANSUhEUg'] }]
  assert.equal(typeof toOpenAIMessages(msgs)[0].content, 'string', 'no options object must mean no images sent')
  assert.equal(typeof toOpenAIRequest({ messages: msgs }).messages[0].content, 'string')
})

test('the image mime type is read from the payload, not guessed', () => {
  const cases = [['/9j/4AAQSkZJRg', 'image/jpeg'], ['iVBORw0KGgoAAAA', 'image/png'],
                 ['R0lGODlhAQABAI', 'image/gif'], ['UklGRiQAAABXRUJQ', 'image/webp'],
                 ['ZZZZunrecognised', 'image/png']]
  for (const [b64, mime] of cases) {
    const out = toOpenAIMessages([{ role: 'user', content: '', images: [b64] }], { vision: true })
    assert.match(out[0].content[0].image_url.url, new RegExp(`^data:${mime.replace('/', '\/')};base64,`), b64)
  }
})

test('the Kaggle path asks the compute manager whether vision is actually available', async () => {
  const src = await fs.readFile('./adapters/ollama.js', 'utf8')
  assert.match(src, /postOpenAIChat\(targetUrl, body, \{ signal, vision: getKaggleVision\(\) \}\)/,
    'Kaggle must pass the REAL projector state, never assume it')
})
