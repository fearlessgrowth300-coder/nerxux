import test from 'node:test'
import assert from 'node:assert/strict'

// A turn that runs out of rounds while still calling tools used to end with an
// EMPTY reply: the chat showed a bare "Model Executed 76 Tool Actions" card and
// nobody could tell what had been done. It must now end with an account of the
// work and a plain statement that the turn was cut off.
const { run } = await import('../adapters/ollama.js')

const TOOL = {
  name: 'generate_image',
  description: 'Generate an image',
  input_schema: { type: 'object', properties: { prompt: { type: 'string' } } },
}

function stub({ neverStops }) {
  const bodies = []
  let n = 0
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    bodies.push(body)
    // The wrap-up request is the one sent without tools.
    if (!body.tools) {
      return { ok: true, json: async () => ({ message: { content: 'Changed app/raw_twitch.py. Tests still to run.' }, done_reason: 'stop' }) }
    }
    if (!neverStops && n > 0) {
      return { ok: true, json: async () => ({ message: { content: 'All done.' }, done_reason: 'stop' }) }
    }
    n++
    // Different args every round, so the duplicate-call guard never trips.
    return {
      ok: true,
      json: async () => ({
        message: { content: '', tool_calls: [{ function: { name: 'generate_image', arguments: { prompt: `step ${n}` } } }] },
        done_reason: 'stop',
      }),
    }
  }
  return bodies
}

test('a turn that runs out of rounds mid-work ends with a summary, not an empty reply', async () => {
  const realFetch = globalThis.fetch
  const bodies = stub({ neverStops: true })
  try {
    const res = await run({
      prompt: 'keep working',
      tools: [TOOL],
      onToolCall: async () => ({ content: 'ok' }),
    })
    assert.ok(res.toolSteps.length >= 60, 'fixture must actually exhaust the rounds')
    assert.notEqual(res.content.trim(), '', 'an empty reply is exactly the bug')
    assert.match(res.content, /Changed app\/raw_twitch\.py/, 'the model-written summary is included')
    assert.match(res.content, /limit for one turn was reached/, 'the cut-off is stated plainly')
    assert.match(res.content, /Send "continue"/)
    assert.equal(bodies.filter((b) => !b.tools).length, 1, 'exactly one wrap-up request')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a turn that finishes normally gets no wrap-up and no cut-off note', async () => {
  const realFetch = globalThis.fetch
  const bodies = stub({ neverStops: false })
  try {
    const res = await run({
      prompt: 'do one thing',
      tools: [TOOL],
      onToolCall: async () => ({ content: 'ok' }),
    })
    assert.equal(res.content, 'All done.')
    assert.doesNotMatch(res.content, /limit for one turn/)
    assert.equal(bodies.filter((b) => !b.tools).length, 0, 'no wrap-up request for a finished turn')
  } finally {
    globalThis.fetch = realFetch
  }
})
