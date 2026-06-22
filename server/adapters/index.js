import * as claude from './claude.js'
import * as openai from './openai.js'
import * as gemini from './gemini.js'
import * as elevenlabs from './elevenlabs.js'
import * as higgsfield from './higgsfield.js'
import * as nexus from './nexus.js'
import { getProviderKey } from '../lib/vault.js'

// Maps a provider id to its adapter module. Each adapter exposes `run(args)`
// and returns a normalized response { ok, provider, type, content, media?, ... }.
// `nexus` is the user's own locally-trained model (no API key needed).
export const ADAPTERS = { claude, openai, gemini, elevenlabs, higgsfield, nexus }

// Resolves the key for `provider` (the user's own key, else the platform key)
// and invokes the adapter. Throws if the provider is unknown.
export async function runTool(provider, userId, args = {}) {
  const adapter = ADAPTERS[provider]
  if (!adapter) throw new Error(`No adapter for provider "${provider}"`)
  const apiKey = await getProviderKey(userId, provider)
  return adapter.run({ ...args, apiKey })
}
