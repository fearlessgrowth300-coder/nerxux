import test from 'node:test'
import assert from 'node:assert/strict'
import { editedHistory } from '../src/lib/chatWorkspace.js'

// Editing forks a new chat so the original is preserved. But Edit is also the
// natural way to RETRY a turn that errored — and forking there starts a fresh
// conversation, so the model sees only the edited message and answers as if
// nothing had been discussed. That produced five near-identical 5-message
// conversations instead of one continuing thread.
const isRetry = (messages, id) => {
  const i = messages.findIndex((m) => m.id === id && m.role === 'user')
  return i >= 0 && messages.slice(i + 1).every((m) => m.error)
}

const convo = [
  { id: 'u1', role: 'user', content: 'build the thing' },
  { id: 'a1', role: 'assistant', content: 'done, here is the URL' },
  { id: 'u2', role: 'user', content: 'now add auth' },
]

test('resending after a failed reply is a retry, not a fork', () => {
  const failed = [...convo, { id: 'a2', role: 'assistant', content: '⚠️ Can not reach tunnel', error: true }]
  assert.equal(isRetry(failed, 'u2'), true)
})

test('resending with no reply yet is also a retry', () => {
  assert.equal(isRetry(convo, 'u2'), true)
})

test('editing an earlier message with real work after it still forks', () => {
  assert.equal(isRetry(convo, 'u1'), false, 'a1 is a real answer — editing u1 must not rewrite this chat')
})

test('a fork keeps everything before the edited message', () => {
  const h = editedHistory(convo, 'u2', 'now add auth with Supabase')
  assert.deepEqual(h.map((m) => m.id), ['u1', 'a1', 'u2'])
  assert.equal(h.at(-1).content, 'now add auth with Supabase')
  assert.equal(h.at(-1).edited, true)
})

// The specific shape that bit the user: editing the FIRST message leaves the
// model with a single line of context.
test('editing the first message leaves only that message as context', () => {
  const h = editedHistory(convo, 'u1', 'build the thing, again')
  assert.equal(h.length, 1)
  assert.equal(h[0].content, 'build the thing, again')
})
