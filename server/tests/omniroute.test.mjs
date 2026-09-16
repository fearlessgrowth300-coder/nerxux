import test from 'node:test'
import assert from 'node:assert/strict'
import { ADAPTERS } from '../adapters/index.js'
import { PROVIDERS, CHAT_MODELS, getModelById } from '../../shared/models.js'
import { platformKey } from '../lib/vault.js'
import { getAvailableModels, _fetchers } from '../lib/liveModels.js'

test('OmniRoute is a provider with an adapter, a platform key and auto models', () => {
  assert.ok(PROVIDERS.omniroute)
  assert.equal(typeof ADAPTERS.omniroute.run, 'function')
  const prev = process.env.OMNIROUTE_API_KEY
  process.env.OMNIROUTE_API_KEY = 'or-test-key'
  try { assert.equal(platformKey('omniroute'), 'or-test-key') } finally {
    if (prev === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = prev
  }
  const autos = CHAT_MODELS.filter((m) => m.provider === 'omniroute')
  assert.ok(autos.length >= 4)
  assert.ok(autos.every((m) => /^auto(\/|$)/.test(m.apiModel)))
  assert.equal(getModelById('omniroute-best-coding').apiModel, 'auto/best-coding')
})

test('the adapter talks to the local gateway with the OpenAI protocol', async () => {
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'opencode/big-pickle', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const prev = process.env.OMNIROUTE_URL
  process.env.OMNIROUTE_URL = 'http://127.0.0.1:20128/v1'
  try {
    const r = await ADAPTERS.omniroute.run({ prompt: 'ping', apiKey: 'or-key', model: 'auto/best-coding' })
    assert.equal(r.provider, 'omniroute')
    assert.equal(r.content, 'pong')
    assert.match(seen[0].url, /^http:\/\/127\.0\.0\.1:20128\/v1\/chat\/completions/)
    assert.equal(seen[0].auth, 'Bearer or-key')
    assert.equal(seen[0].body.model, 'auto/best-coding')
  } finally {
    globalThis.fetch = realFetch
    if (prev === undefined) delete process.env.OMNIROUTE_URL; else process.env.OMNIROUTE_URL = prev
  }
})

test('a missing key and a stopped service give actionable errors', async () => {
  await assert.rejects(ADAPTERS.omniroute.run({ prompt: 'x', apiKey: null }), /OmniRoute API key is not connected/)
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('fetch failed') }
  try {
    await assert.rejects(ADAPTERS.omniroute.run({ prompt: 'x', apiKey: 'k' }), /systemctl status omniroute/)
  } finally { globalThis.fetch = realFetch }
})

test('the dropdown shows only auto/* profiles, curated first, and only when connected', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { id: 'auto/best-coding' }, { id: 'auto' }, { id: 'auto/cheap' }, { id: 'opencode/big-pickle' }, { id: 'groq/llama-3.3-70b' },
  ] }), { status: 200 })
  try {
    const list = await _fetchers.omniroute('k')
    assert.deepEqual(list.map((m) => m.apiModel), ['auto/best-coding', 'auto', 'auto/cheap'])
    assert.equal(list[0].label, 'OmniRoute auto: best coding (free gateway)')
    const connected = await getAvailableModels('u-omni-1', [{ provider: 'omniroute' }], async () => 'k')
    assert.ok(connected.some((m) => m.provider === 'omniroute'))
    const notConnected = await getAvailableModels('u-omni-2', [], async () => null)
    assert.ok(!notConnected.some((m) => m.provider === 'omniroute'), 'hidden when the server has no OmniRoute key')
  } finally { globalThis.fetch = realFetch }
})
