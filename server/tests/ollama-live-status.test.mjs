import test from 'node:test'
import assert from 'node:assert/strict'
import { parseProgressLine } from '../lib/ollamaReadProgress.js'
import { readChatResponse } from '../adapters/ollama.js'

test('parses the prompt-processing line Ollama logs while it reads', () => {
  const p = parseProgressLine('slot print_timing: id  0 | task 1511 | prompt processing, n_tokens =   5120, progress = 0.28, t =  83.52 s / 61.30 tokens per second')
  assert.equal(p.task, '1511')
  assert.equal(p.tokens, 5120)
  assert.equal(p.progress, 0.28)
  assert.equal(p.totalTokens, 18286)
  assert.equal(p.tokPerSec, 61.3)
  assert.equal(parseProgressLine('slot print_timing: id 0 | task 1511 | n_gen = 100, tg = 10.51 t/s'), null)
})

const streamOf = (lines) => {
  const enc = new TextEncoder()
  // Split mid-line on purpose: network chunks don't respect newlines.
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  const mid = Math.floor(text.length / 2)
  return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(enc.encode(text.slice(0, mid))); c.enqueue(enc.encode(text.slice(mid))); c.close() } }) }
}

test('a streamed reply is reassembled into the same shape as a non-streamed one', async () => {
  const seen = []
  const data = await readChatResponse(streamOf([
    { message: { role: 'assistant', content: '', thinking: 'hmm ' } },
    { message: { role: 'assistant', content: 'Hel' } },
    { message: { role: 'assistant', content: 'lo', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } }] } },
    { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12 },
  ]), (c) => seen.push(c))
  assert.equal(data.message.content, 'Hello')
  assert.equal(data.message.thinking, 'hmm ')
  assert.equal(data.message.tool_calls[0].function.name, 'read_file')
  assert.equal(data.done_reason, 'stop')
  assert.equal(data.prompt_eval_count, 12)
  assert.equal(seen.length, 4)
})

test('an error in the middle of a stream is returned, not swallowed', async () => {
  const data = await readChatResponse(streamOf([{ message: { content: 'x' } }, { error: 'XML syntax error on line 3' }]))
  assert.equal(data.error, 'XML syntax error on line 3')
})

test('a plain JSON body still works', async () => {
  const data = await readChatResponse({ ok: true, json: async () => ({ message: { content: 'hi' } }) })
  assert.equal(data.message.content, 'hi')
})
