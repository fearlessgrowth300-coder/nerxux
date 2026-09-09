// Fetches the actual current model list from each provider's own API, so the
// dropdown shows whatever they've shipped lately instead of a hardcoded list
// that goes stale. Falls back to the curated CHAT_MODELS entries for a
// provider whenever the live fetch fails or comes back empty — the dropdown
// should never end up thinner than the static list, only richer.
import { CHAT_MODELS } from '../../shared/models.js'
import { getProviderKey } from './vault.js'

const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map() // `${userId}:${provider}` -> { at, models }

function cached(key) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.models
  return null
}
function setCache(key, models) {
  cache.set(key, { at: Date.now(), models })
}

// id = "<provider>/<apiModel>" (see shared/models.js getModelById) so a model
// neither side hardcoded still routes correctly.
const entry = (provider, apiModel, label, vision) => ({
  id: `${provider}/${apiModel}`, provider, apiModel, label: label || apiModel, vision: Boolean(vision), live: true,
})

async function fetchClaudeModels(apiKey) {
  const r = await fetch('https://api.anthropic.com/v1/models?limit=50', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  })
  if (!r.ok) throw new Error(`Anthropic models ${r.status}`)
  const j = await r.json()
  return (j.data || []).map((m) => entry('claude', m.id, m.display_name, true))
}

async function fetchOpenAIModels(apiKey) {
  const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!r.ok) throw new Error(`OpenAI models ${r.status}`)
  const j = await r.json()
  return (j.data || [])
    .filter((m) => /^(gpt-|o1|o3|o4|chatgpt)/i.test(m.id) && !/embedding|whisper|tts|dall-e|moderation|davinci|babbage|audio|realtime|transcribe/i.test(m.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .slice(0, 15)
    .map((m) => entry('openai', m.id, m.id, /gpt-4o|gpt-5|o3|vision/i.test(m.id)))
}

async function fetchGeminiModels(apiKey) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${encodeURIComponent(apiKey)}`)
  if (!r.ok) throw new Error(`Gemini models ${r.status}`)
  const j = await r.json()
  const version = (id) => Number((/gemini-(\d+(?:\.\d+)?)/.exec(id) || [])[1]) || 0
  return (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => {
      const apiModel = String(m.name || '').replace(/^models\//, '')
      return entry('gemini', apiModel, m.displayName, true)
    })
    .sort((a, b) => version(b.apiModel) - version(a.apiModel))
}

async function fetchGroqModels(apiKey) {
  const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!r.ok) throw new Error(`Groq models ${r.status}`)
  const j = await r.json()
  return (j.data || [])
    .filter((m) => m.active !== false && !/whisper|tts|guard|prompt-guard/i.test(m.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map((m) => entry('groq', m.id, m.id, /scout|maverick|vision|llava/i.test(m.id)))
}

const FETCHERS = { claude: fetchClaudeModels, openai: fetchOpenAIModels, gemini: fetchGeminiModels, groq: fetchGroqModels }
// Exported for tests only — real callers go through getAvailableModels.
export const _fetchers = FETCHERS

// Returns live models for one provider (cached), or null on any failure —
// callers fall back to the static list, never surface the error to chat.
async function liveModelsFor(userId, provider, apiKey) {
  const key = `${userId}:${provider}`
  const hit = cached(key)
  if (hit) return hit
  try {
    const models = await FETCHERS[provider](apiKey)
    if (!models.length) return null
    setCache(key, models)
    return models
  } catch {
    return null // stale key, rate limit, network blip — the static list covers it
  }
}

// Builds the full model list for the dropdown: live models for every
// connected provider we can fetch them for, that provider's curated static
// entries as a fallback, plus every no-key-required model (nexus/ollama)
// untouched. `connections` = listConnections(userId) — already filtered to
// providers that are actually usable (own key or platform key).
// `resolveKey` defaults to the real vault lookup; tests inject a stub so
// this doesn't need a live Supabase connection to exercise the merge logic.
export async function getAvailableModels(userId, connections, resolveKey = (provider) => getProviderKey(userId, provider)) {
  const results = []
  const staticByProvider = new Map()
  for (const m of CHAT_MODELS) {
    if (!staticByProvider.has(m.provider)) staticByProvider.set(m.provider, [])
    staticByProvider.get(m.provider).push(m)
  }

  const chatProviders = connections.map((c) => c.provider).filter((p) => FETCHERS[p])
  const fetched = await Promise.all(
    chatProviders.map(async (provider) => {
      const apiKey = await resolveKey(provider).catch(() => null)
      return [provider, apiKey ? await liveModelsFor(userId, provider, apiKey) : null]
    })
  )
  for (const [provider, live] of fetched) {
    results.push(...(live?.length ? live : staticByProvider.get(provider) || []))
  }
  // nexus/ollama and anything else with no key requirement: always available.
  for (const m of CHAT_MODELS) {
    if (!FETCHERS[m.provider] && !results.some((r) => r.id === m.id)) results.push(m)
  }
  return results
}
