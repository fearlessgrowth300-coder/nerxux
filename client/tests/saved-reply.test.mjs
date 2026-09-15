import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeHistory, hasReplyToLastMessage } from '../src/lib/chatWorkspace.js'

// A 50-minute Always On turn finished while the phone was locked. The server
// wrote the reply into History, but the app showed "That request has expired —
// please resend", and after a reload that stale error card stayed pinned under
// the answer, so the reply looked like it never came back.
const user = { id: 'u', role: 'user', content: 'build it' }
const reply = { id: 'r', role: 'assistant', content: 'done' }
const expired = { id: 'e', role: 'assistant', content: '⚠️ That request has expired — please resend your message.', error: true }

test('a reply saved by the server counts as the answer', () => {
  assert.equal(hasReplyToLastMessage([user, reply]), true)
  assert.equal(hasReplyToLastMessage([user]), false)
  assert.equal(hasReplyToLastMessage([user, expired]), false, 'an error card is not an answer')
  assert.equal(hasReplyToLastMessage([]), false)
})

test('the stale expired card is dropped once History has the reply', () => {
  assert.deepEqual(mergeHistory([user, reply], [user, expired]), [user, reply])
})

test('with no reply in History, local-only messages are kept', () => {
  assert.deepEqual(mergeHistory([user], [user, expired]), [user, expired])
  const unsynced = { id: 'x', role: 'user', content: 'not synced yet' }
  assert.deepEqual(mergeHistory([user, reply], [user, unsynced]), [user, reply, unsynced])
})
