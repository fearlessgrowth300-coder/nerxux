import test from 'node:test'
import assert from 'node:assert/strict'

// The local models (Qwen) used to be the only ones that couldn't reach a
// connected MCP tool: chat.js passed `tools: undefined` for them. These cover
// the wiring end to end with Ollama itself stubbed out.
const { run } = await import('../adapters/ollama.js')

const IMAGE_TOOL = {
  name: 'generate_image',
  description: 'Generate an image',
  input_schema: { type: 'object', properties: { prompt: { type: 'string' } } },
}

// Replies in order, recording what was sent.
function stubOllama(replies) {
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body))
    const message = replies.shift() ?? { content: 'done' }
    return { ok: true, json: async () => ({ message, done_reason: 'stop' }) }
  }
  return sent
}

test('a connected MCP tool is offered to the local model and its call is routed out', async () => {
  const realFetch = globalThis.fetch
  const sent = stubOllama([
    { content: '', tool_calls: [{ function: { name: 'generate_image', arguments: { prompt: 'a cat' } } }] },
    { content: 'Here is your image.' },
  ])
  const calls = []
  try {
    const res = await run({
      prompt: 'draw a cat',
      tools: [IMAGE_TOOL],
      onToolCall: async (name, args) => {
        calls.push({ name, args })
        return {
          content: 'generated',
          mediaList: [{ type: 'image', mimeType: 'image/png', url: 'https://cdn.example/cat.png' }],
        }
      },
    })

    const offered = sent[0].tools.map((t) => t.function.name)
    assert.ok(offered.includes('generate_image'), 'connector tool must be offered to the model')
    assert.ok(offered.includes('execute_command'), 'the sandbox tools must still be there too')
    assert.deepEqual(calls, [{ name: 'generate_image', args: { prompt: 'a cat' } }])
    assert.equal(res.type, 'image')
    assert.equal(res.media.url, 'https://cdn.example/cat.png')
    assert.equal(res.toolSteps.at(-1).target, 'connector')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('every generated image is kept, not just the last one', async () => {
  const realFetch = globalThis.fetch
  stubOllama([
    { content: '', tool_calls: [{ function: { name: 'generate_image', arguments: { prompt: 'four cats' } } }] },
    { content: 'Done.' },
  ])
  try {
    const res = await run({
      prompt: 'draw four cats',
      tools: [IMAGE_TOOL],
      onToolCall: async () => ({
        content: 'generated 4',
        mediaList: [1, 2, 3, 4].map((n) => ({ type: 'image', mimeType: 'image/png', url: `https://cdn.example/${n}.png` })),
      }),
    })
    assert.equal(res.mediaList.length, 4, 'all four images must reach the chat')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a sandbox tool still runs locally rather than being sent to a connector', async () => {
  const realFetch = globalThis.fetch
  stubOllama([{ content: 'nothing to do' }])
  let routedOut = false
  try {
    await run({ prompt: 'hi', tools: [IMAGE_TOOL], onToolCall: async () => { routedOut = true; return { content: '' } } })
    assert.equal(routedOut, false)
  } finally {
    globalThis.fetch = realFetch
  }
})
