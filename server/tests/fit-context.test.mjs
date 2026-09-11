import test from 'node:test'
import assert from 'node:assert/strict'
import { fitMessages, estimateTokens } from '../lib/fitContext.js'

const msg = (role, chars) => ({ role, content: 'x'.repeat(chars) })

// The real failure: 32,789 tokens against a 32,768 window. Twenty-one over, and
// every further message in that conversation failed for good.
test('a conversation that overflows is brought under the budget', () => {
  const convo = [msg('system', 4000), ...Array.from({ length: 40 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 4000))]
  assert.ok(convo.reduce((n, m) => n + estimateTokens(m), 0) > 40000, 'fixture must actually overflow')

  const { messages, dropped, estimated } = fitMessages(convo, 20000)
  assert.ok(estimated <= 20000, `still ${estimated} tokens, over budget`)
  assert.ok(dropped > 0)
  assert.equal(messages[0].role, 'system', 'the system prompt is never dropped')
})

test('what is kept is the RECENT end — that is where the task is', () => {
  const convo = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'the oldest thing' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'THE CURRENT TASK' },
  ]
  // Enough for the system prompt, the dropped-notice, and the newest turn.
  const { messages } = fitMessages(convo, 120)
  assert.equal(messages.at(-1).content, 'THE CURRENT TASK')
})

test('the model is told something was left out, not deceived', () => {
  const convo = [msg('system', 100), ...Array.from({ length: 20 }, () => msg('user', 4000))]
  const { messages, dropped } = fitMessages(convo, 5000)
  assert.ok(dropped > 0)
  assert.match(messages[1].content, /left out to fit the context window/)
})

test('a conversation that already fits is untouched', () => {
  const convo = [msg('system', 100), msg('user', 200), msg('assistant', 200)]
  const { messages, dropped } = fitMessages(convo, 100000)
  assert.equal(dropped, 0)
  assert.deepEqual(messages, convo)
})

// Sending nothing would be worse than sending a shortened version.
test('a single oversized message is shortened rather than dropped', () => {
  const { messages, estimated } = fitMessages([msg('system', 100), msg('user', 400000)], 5000)
  assert.equal(messages.at(-1).role, 'user')
  assert.match(messages.at(-1).content, /trimmed to fit the context window/)
  assert.ok(estimated <= 5000)
})

// Images are not free — they become a large block of vision tokens, and
// ignoring them is how an estimate ends up 21 tokens short.
test('images are counted, and survive trimming', () => {
  const withImage = { role: 'user', content: 'look at this', images: ['base64data'] }
  assert.ok(estimateTokens(withImage) > 1000, 'an image must cost more than its caption')

  const { messages } = fitMessages([msg('system', 100), msg('user', 8000), withImage], 6000)
  assert.deepEqual(messages.at(-1).images, ['base64data'], 'the attachment must not be stripped')
})
