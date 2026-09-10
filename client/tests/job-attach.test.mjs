import test from 'node:test'
import assert from 'node:assert/strict'

// Opening the app on a second device asked the server what was still running
// and attached to `running[0]` when nothing matched the current conversation.
// So the phone adopted a job belonging to a DIFFERENT chat: its progress
// rendered into the wrong conversation, and that conversation was then "busy",
// which silently blocked every History click.
const pick = (running, currentConversationId) =>
  running.find((j) => j.conversationId && j.conversationId === currentConversationId) || null

const RUNNING = [
  { jobId: 'job-hi', conversationId: 'conv-hi' },
  { jobId: 'job-build', conversationId: 'conv-build' },
]

test('a job from another conversation is never adopted', () => {
  assert.equal(pick(RUNNING, 'conv-something-else'), null)
  assert.equal(pick(RUNNING, null), null)
  assert.equal(pick([], 'conv-hi'), null)
})

test('the job for the conversation being viewed is attached', () => {
  assert.equal(pick(RUNNING, 'conv-hi').jobId, 'job-hi')
  assert.equal(pick(RUNNING, 'conv-build').jobId, 'job-build')
})

// A reply that lands after the user has moved on belongs to the chat it was
// started in — rendering it into whatever is on screen is how "hi" ended up
// inside another conversation.
const shouldRender = (jobConversationId, currentConversationId) =>
  !jobConversationId || jobConversationId === currentConversationId

test('a late reply renders only in its own conversation', () => {
  assert.equal(shouldRender('conv-hi', 'conv-hi'), true)
  assert.equal(shouldRender('conv-hi', 'conv-build'), false)
  assert.equal(shouldRender(null, 'conv-build'), true, 'a job with no conversation is a local draft')
})
