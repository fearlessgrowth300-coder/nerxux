import { supabaseAdmin } from './supabase.js'
import { encrypt, decrypt } from './crypto.js'
import { PROVIDERS } from '../../shared/models.js'

export const VALID_PROVIDERS = Object.keys(PROVIDERS)

export function isValidProvider(provider) {
  return VALID_PROVIDERS.includes(provider)
}

// Recognize which provider an API key belongs to from its prefix, so the user
// can just paste a key and we file it under the right provider automatically.
// Returns a provider id, or null if the format isn't recognized.
export function detectProvider(apiKey) {
  const k = String(apiKey || '').trim()
  if (!k) return null
  if (k.startsWith('sk-ant-')) return 'claude'       // Anthropic / Claude
  if (k.startsWith('gsk_')) return 'groq'            // Groq
  if (k.startsWith('AIza')) return 'gemini'          // Google Gemini
  if (k.startsWith('sk-')) return 'openai'           // OpenAI (incl. sk-proj-)
  if (k.startsWith('sk_')) return 'elevenlabs'       // ElevenLabs (underscore)
  return null                                        // e.g. Higgsfield — pick manually
}

// Platform-level fallback keys set by the app owner (server env). These let the
// whole app work out-of-the-box (like Claude.ai) without each user bringing keys.
const PLATFORM_ENV = {
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  higgsfield: 'HIGGSFIELD_API_KEY',
}

export function platformKey(provider) {
  const v = process.env[PLATFORM_ENV[provider]]
  return v && v.trim() ? v.trim() : null
}

export function hasPlatformKey(provider) {
  return Boolean(platformKey(provider))
}

// Resolves the key to use for a provider: the user's own key (if connected),
// otherwise the platform key. This is what adapters should call.
export async function getProviderKey(userId, provider) {
  return (await getDecryptedKey(userId, provider)) || platformKey(provider)
}

// True if a provider is usable for this user (own key OR platform key).
export async function isProviderAvailable(userId, provider) {
  if (hasPlatformKey(provider)) return true
  return Boolean(await getDecryptedKey(userId, provider))
}

// Lists every provider with its connection status for a user. Never returns
// key material — only whether it's connected and the last 4 chars for display.
export async function listConnections(userId) {
  const { data, error } = await supabaseAdmin
    .from('connections')
    .select('provider, last4, updated_at')
    .eq('user_id', userId)
  if (error) throw error

  const byProvider = new Map((data ?? []).map((r) => [r.provider, r]))

  return VALID_PROVIDERS.map((provider) => {
    const row = byProvider.get(provider)
    return {
      provider,
      label: PROVIDERS[provider].label,
      connected: Boolean(row),
      last4: row?.last4 ?? null,
      updated_at: row?.updated_at ?? null,
      // True when the app owner has set a platform key — the provider works for
      // everyone even without a personal key.
      platform: hasPlatformKey(provider),
    }
    // Only surface providers that are actually usable (a personal key or a
    // platform key). The UI is an "add what you need" list, not a fixed roster.
  }).filter((c) => c.connected || c.platform)
}

// Encrypts and upserts a provider key for a user. Returns display-safe status.
export async function setConnection(userId, provider, apiKey) {
  if (!isValidProvider(provider)) throw new Error(`Unknown provider: ${provider}`)
  const key = String(apiKey || '').trim()
  if (!key) throw new Error('API key is required')

  const { ciphertext, iv, tag } = encrypt(key)
  const last4 = key.slice(-4)

  const { error } = await supabaseAdmin.from('connections').upsert(
    {
      user_id: userId,
      provider,
      key_ciphertext: ciphertext,
      key_iv: iv,
      key_tag: tag,
      last4,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,provider' }
  )
  if (error) throw error

  return { provider, label: PROVIDERS[provider].label, connected: true, last4 }
}

export async function deleteConnection(userId, provider) {
  if (!isValidProvider(provider)) throw new Error(`Unknown provider: ${provider}`)
  const { error } = await supabaseAdmin
    .from('connections')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider)
  if (error) throw error
}

// Server-internal: returns the DECRYPTED key for use by adapters (Step 11).
// Never expose the return value of this over the API.
export async function getDecryptedKey(userId, provider) {
  const { data, error } = await supabaseAdmin
    .from('connections')
    .select('key_ciphertext, key_iv, key_tag')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return decrypt({
    ciphertext: data.key_ciphertext,
    iv: data.key_iv,
    tag: data.key_tag,
  })
}
