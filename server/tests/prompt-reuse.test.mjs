import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fitMessages } from '../lib/fitContext.js'
import { agentStateRecord } from '../lib/agentState.js'

// Ollama reuses the prefix of the previous request byte-for-byte. Measured on
// Kaggle 2x T4 with a 32k-token agent conversation: 83 s to read it from
// scratch, 3.2 s when the prefix was unchanged. These tests make sure Nexus
// keeps the start of the prompt identical from one agent step to the next.

const msg = (role, i) => ({ role, content: `${role} message ${i} ` + 'x'.repeat(3000) })

test('once trimming starts, one more tool step does not move the start of the prompt', () => {
  const system = { role: 'system', content: 'rules' }
  const convo = [system, ...Array.from({ length: 30 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', i))]
  const budget = 12000
  const a = fitMessages(convo, budget).messages
  assert.ok(a.length < convo.length, 'fixture must actually trim')
  // One more tool step lands (assistant + tool output). Without chunked
  // trimming the cut point moved by exactly these two messages every step.
  const b = fitMessages([...convo, msg('assistant', 30), msg('user', 31)], budget).messages
  const shared = a.filter((m, i) => b[i] && b[i].role === m.role && b[i].content === m.content).length
  assert.ok(shared >= a.length - 2, `only ${shared} of ${a.length} leading messages were unchanged`)
  assert.equal(a[1].content, b[1].content, 'the "left out" notice must not change wording as the count grows')
  assert.doesNotMatch(a[1].content, /\d/, 'the notice carries no changing number')
})

test('a conversation that fits is still sent untouched', () => {
  const convo = [{ role: 'system', content: 'rules' }, msg('user', 0), msg('assistant', 1)]
  assert.deepEqual(fitMessages(convo, 100000).messages, convo)
})

test('the Ollama adapter fixes the system prompt once and appends the live record last', async () => {
  const src = await fs.readFile('./adapters/ollama.js', 'utf8')
  assert.match(src, /if \(step === 0\) messages\[0\]\.content = system \+ state\.notes/, 'system prompt is written on step 0 only')
  assert.doesNotMatch(src, /messages\[0\]\.content = system \+ '\\n\\n' \+ await agentStatePrompt/, 'the per-step record no longer goes into the system prompt')
  assert.match(src, /messages: \[\.\.\.fitMessages\(messages, promptBudget - recordTokens\)\.messages, record\]/, 'the record is the final message and is budgeted for')
})

test('the execution record is the changing half, and is not in the notes', () => {
  const s = { environment: 'sandbox', projectPath: '/p', revision: 3, gateAfter: null, inFlight: null, nextStep: null, jobs: [], checks: [], changes: [], events: [] }
  const r = agentStateRecord(s)
  assert.match(r, /^Nexus execution record/)
  assert.match(r, /"revision":3/)
  assert.doesNotMatch(r, /Project notes/)
})
