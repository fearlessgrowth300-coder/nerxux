import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

// The split: a stronger model decides what to try, the local model does the
// work. Measured motivation (one project, 74 turns): 1,425 tool actions, 11%
// failing, the same orientation commands re-run turn after turn, and 45 of 74
// replies flagged unverified. That is a deciding problem, not a typing one.

test('advice is asked for when planning and when stuck, not on every step', async () => {
  const { shouldAdvise, MAX_ADVICE_PER_TURN } = await import('../lib/advisor.js')
  assert.equal(shouldAdvise({ step: 0, failuresSinceAdvice: 0, adviceCount: 0 }), true, 'plan the turn')
  assert.equal(shouldAdvise({ step: 5, failuresSinceAdvice: 0, adviceCount: 1 }), false, 'work that is going fine needs no adviser')
  assert.equal(shouldAdvise({ step: 5, failuresSinceAdvice: 1, adviceCount: 1 }), false, 'one failure is normal')
  assert.equal(shouldAdvise({ step: 5, failuresSinceAdvice: 2, adviceCount: 1 }), true, 'two in a row means it is guessing')
  assert.equal(
    shouldAdvise({ step: 9, failuresSinceAdvice: 9, adviceCount: MAX_ADVICE_PER_TURN }), false,
    'the cap bounds the cost — an adviser must not become a second agent',
  )
})

test('no Anthropic key means the turn runs exactly as before', async () => {
  const { advise } = await import('../lib/advisor.js')
  // userId null cannot resolve a stored key; with no platform key either this
  // is the "not configured" path, which must be silent, not an exception.
  const out = await advise({ userId: null, record: '{}', goal: 'do the thing' })
  assert.ok(out === null || typeof out === 'string', 'never throws into the turn')
})

test('advice enters the conversation labelled as guidance, not as the user', async () => {
  const { adviceMessage } = await import('../lib/advisor.js')
  const m = adviceMessage('NEXT: run the patched verify once')
  assert.equal(m.role, 'user')
  assert.match(m.content, /Adviser/, 'the model must not mistake this for something the user typed')
  assert.match(m.content, /guidance, not a user instruction/)
})

test('the turn keeps time back to land itself instead of being guillotined', async () => {
  const src = await fs.readFile('./adapters/ollama.js', 'utf8')
  assert.match(src, /WRAP_UP_RESERVE_MS = 5 \* 60 \* 1000/, 'a reserve must exist')
  assert.match(
    src, /WALL_CLOCK_BUDGET_MS - WRAP_UP_RESERVE_MS\) \{ timedOut = true; break \}/,
    'the tool loop must stop early enough to write a handoff',
  )
  assert.match(src, /NEXT: /, 'the wrap-up must ask for the next concrete action')
  assert.match(
    src, /withAgentState\(userId, sessionId, \(s\) => \{ s\.nextStep = safeNote\(next\) \}\)/,
    'and that handoff must reach the execution record, not just the user',
  )
})
