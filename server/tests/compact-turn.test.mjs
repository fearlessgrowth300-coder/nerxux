import test from 'node:test'
import assert from 'node:assert/strict'
import { fitTurn, observationStub } from '../lib/compactTurn.js'
import { estimateTokens } from '../lib/fitContext.js'

const text = (n, ch = 'x') => ch.repeat(n)

// Replays the real turn (2026-09-15): a 64-message chat, a ~5k-char request,
// then reads of 2.3k, 2.6k, 9.9k, 12k, 12.7k and 19.3k chars against Always
// On's 14k-token budget. Before, the request and the earlier reads were simply
// dropped; the model re-read the same four files for 50 minutes.
function realTurn() {
  const obsMeta = new WeakMap()
  const messages = [{ role: 'system', content: text(9000, 's') }]
  for (let i = 0; i < 60; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: text(1100, 'h') })
  const request = { role: 'user', content: 'REQUEST ' + text(5076, 'r') }
  messages.push(request)
  const reads = [['app/account_factory.py', 2334], ['app/real_inbox.py', 2562], ['app/real_inbox.py', 9872], ['NEXUS.md', 12055], ['app/tempmail.py', 12734], ['app/account_factory.py', 19269]]
  const obs = []
  for (const [path, chars] of reads) {
    messages.push({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path } } }] })
    const m = { role: 'tool', tool_name: 'read_file', content: text(chars, 'f') }
    obsMeta.set(m, { name: 'read_file', path, chars })
    messages.push(m)
    obs.push(m)
  }
  return { messages, request, obsMeta, obs }
}

test('the request being worked on survives trimming', () => {
  const { messages, request, obsMeta } = realTurn()
  const { messages: out } = fitTurn(messages, 14000, { request, obsMeta })
  assert.ok(out.some((m) => m.role === 'user' && String(m.content).includes('REQUEST')), 'the request was dropped')
  assert.ok(out.reduce((n, m) => n + estimateTokens(m), 0) <= 14000, 'over budget')
})

test('older file reads become a one-line note instead of vanishing; the newest stay whole', () => {
  const { messages, request, obsMeta, obs } = realTurn()
  const { messages: out, stubbed } = fitTurn(messages, 14000, { request, obsMeta })
  const last = obs.at(-1)
  assert.ok(out.some((m) => String(m.content).endsWith(last.content)), 'the newest read must be sent whole')
  assert.ok(stubbed.size > 0, 'nothing was shrunk')
  const notes = out.filter((m) => /^\[Earlier read_file /.test(String(m.content)))
  assert.ok(notes.some((m) => m.content.includes('app/real_inbox.py')), 'the model is not told it already read real_inbox.py')
  for (const m of notes) assert.match(m.content, /do not read the whole file again/)
})

test('a turn that fits is sent unchanged', () => {
  const obsMeta = new WeakMap()
  const request = { role: 'user', content: 'do it' }
  const o = { role: 'tool', content: 'file body' }
  obsMeta.set(o, { name: 'read_file', path: 'a.js', chars: 9 })
  const messages = [{ role: 'system', content: 'rules' }, request, o]
  const { messages: out, stubbed } = fitTurn(messages, 10000, { request, obsMeta })
  assert.deepEqual(out, messages)
  assert.equal(stubbed.size, 0)
})

test('an oversized request is shortened, not lost', () => {
  const request = { role: 'user', content: 'START ' + text(60000, 'r') + ' END' }
  const messages = [{ role: 'system', content: 'rules' }, request, { role: 'assistant', content: text(8000, 'a') }, { role: 'user', content: text(8000, 'u') }]
  const { messages: out } = fitTurn(messages, 6000, { request })
  const pinned = out.find((m) => String(m.content).includes('START'))
  assert.ok(pinned, 'request missing')
  assert.match(pinned.content, /END$/)
  assert.ok(out.reduce((n, m) => n + estimateTokens(m), 0) <= 6000)
})

test('the stub names the file and range', () => {
  assert.match(observationStub({ name: 'read_file', path: 'app/x.py', start: 1, limit: 150, chars: 5000 }), /read_file app\/x\.py \(lines 1-150\): output \(5000 chars\) removed/)
  assert.match(observationStub({ name: 'execute_command', path: '`npm test`', chars: 900 }), /Earlier execute_command `npm test`: output \(900 chars\) removed to save space\.\]$/)
})

test('the adapter wires in the guard, the request pin and shorter Always On reads', async () => {
  const src = await import('node:fs').then((fs) => fs.promises.readFile('./adapters/ollama.js', 'utf8'))
  assert.match(src, /fitTurn\(messages, promptBudget - recordTokens, \{ request, obsMeta \}\)/)
  assert.match(src, /readsDone\.has\(readKey\)/)
  assert.match(src, /\['write_file', 'edit_file', 'execute_command'\]\.includes\(call\.name\)\) readsDone\.clear\(\)/)
  assert.match(src, /!generousBudget && call\.args && call\.args\.limit == null/)
})
