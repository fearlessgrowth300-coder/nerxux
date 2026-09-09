import test from 'node:test'
import assert from 'node:assert/strict'
import { getModelById, CHAT_MODELS } from '../../shared/models.js'
import { _fetchers, getAvailableModels } from '../lib/liveModels.js'

test('getModelById resolves a live composite id without a static table entry', () => {
  const m = getModelById('gemini/gemini-3-pro-latest')
  assert.deepEqual(m, { id: 'gemini/gemini-3-pro-latest', provider: 'gemini', apiModel: 'gemini-3-pro-latest', label: 'gemini-3-pro-latest' })
  // Plain slugs still resolve from the curated list, unaffected.
  assert.equal(getModelById('claude-sonnet')?.provider, 'claude')
  assert.equal(getModelById('not-a-real-model'), null)
})

function withFetch(handler, fn) {
  const real = global.fetch
  global.fetch = handler
  return fn().finally(() => { global.fetch = real })
}
const ok = (body) => ({ ok: true, json: async () => body })

test('each provider fetcher parses its real response shape into composite-id entries', async () => {
  await withFetch(async () => ok({ data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }, { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }] }), async () => {
    const m = await _fetchers.claude('key')
    assert.deepEqual(m[0], { id: 'claude/claude-opus-5', provider: 'claude', apiModel: 'claude-opus-5', label: 'Claude Opus 5', vision: true, live: true })
  })

  await withFetch(async () => ok({ data: [
    { id: 'gpt-5', created: 200 }, { id: 'gpt-4o', created: 100 }, { id: 'text-embedding-3-large', created: 300 }, { id: 'whisper-1', created: 50 },
  ] }), async () => {
    const m = await _fetchers.openai('key')
    assert.deepEqual(m.map((x) => x.apiModel), ['gpt-5', 'gpt-4o']) // embeddings/whisper excluded, newest first
    assert.equal(m[0].id, 'openai/gpt-5')
  })

  await withFetch(async () => ok({ models: [
    { name: 'models/gemini-1.5-pro', displayName: 'Gemini 1.5 Pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-flash', displayName: 'Gemini 3 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
  ] }), async () => {
    const m = await _fetchers.gemini('key')
    assert.deepEqual(m.map((x) => x.apiModel), ['gemini-3-flash', 'gemini-1.5-pro']) // embedding-only model excluded, newest version first
  })

  await withFetch(async () => ok({ data: [
    { id: 'llama-4-maverick', created: 1, active: true }, { id: 'whisper-large-v3', created: 2, active: true }, { id: 'retired-model', created: 3, active: false },
  ] }), async () => {
    const m = await _fetchers.groq('key')
    assert.deepEqual(m.map((x) => x.apiModel), ['llama-4-maverick']) // inactive + audio model excluded
    assert.equal(m[0].vision, true) // maverick heuristic
  })
})

test('a failed or empty live fetch falls back to the curated static list for that provider, per-provider', async () => {
  await withFetch(async (url) => (String(url).includes('anthropic') ? { ok: false, status: 401 } : ok({ data: [{ id: 'gpt-5', created: 1 }] })), async () => {
    const connections = [{ provider: 'claude', connected: true }, { provider: 'openai', connected: true }]
    const models = await getAvailableModels('live-models-test-user', connections, async () => 'fake-key')
    // Claude: live fetch failed -> curated entries survive.
    assert.equal(models.some((m) => m.id === 'claude-sonnet'), true)
    assert.equal(models.some((m) => m.provider === 'claude' && m.live), false)
    // OpenAI: live fetch succeeded -> its curated 'gpt-4o' is replaced by the live list.
    assert.equal(models.some((m) => m.id === 'openai/gpt-5'), true)
    assert.equal(models.some((m) => m.id === 'gpt-4o'), false)
    // No-key models are always present regardless of any provider's connection state.
    assert.equal(models.some((m) => m.provider === 'nexus' || m.provider === 'ollama'), true)
  })
})
