import * as claude from './claude.js'
import * as openai from './openai.js'
import * as gemini from './gemini.js'
import * as elevenlabs from './elevenlabs.js'
import * as higgsfield from './higgsfield.js'
import { getDecryptedKey } from '../lib/vault.js'

// Maps a provider id to its adapter module. Each adapter exposes `run(args)`
// and returns a normalized response { ok, provider, type, content, media?, ... }.
export const ADAPTERS = { claude, openai, gemini, elevenlabs, higgsfield }

// Resolves the user's key for `provider` from the vault and invokes the adapter.
// Throws if the provider is unknown or the key isn't connected.
export async function runTool(provider, userId, args = {}) {
  const adapter = ADAPTERS[provider]
  if (!adapter) throw new Error(`No adapter for provider "${provider}"`)
  const apiKey = await getDecryptedKey(userId, provider)
  return adapter.run({ ...args, apiKey })
}
