import { runOpenAICompatible } from './groq.js'

// OmniRoute (github.com/diegosouzapw/OmniRoute) runs on the VPS as a gateway:
// one OpenAI-compatible endpoint in front of hundreds of providers, including
// free tiers, with automatic fallback when one is down or out of quota. The
// "auto/*" models let OmniRoute pick the provider for the task.
//
// It listens on 127.0.0.1 only and requires an API key. OMNIROUTE_URL and
// OMNIROUTE_API_KEY live in server/.env (the key is the platform key, so every
// Nexus user can use it without adding their own).
export const OMNIROUTE_URL = () => process.env.OMNIROUTE_URL || 'http://127.0.0.1:20128/v1'

function friendlyError(err) {
  const raw = String(err?.message || err || '')
  if (/ECONNREFUSED|fetch failed|Connection error|ENOTFOUND/i.test(raw)) {
    return new Error("Can't reach OmniRoute on the VPS. Check the service: `systemctl status omniroute`.")
  }
  if (/\b401\b|unauthorized|invalid.?api.?key/i.test(raw)) {
    return new Error('OmniRoute rejected the Nexus API key. Recreate it in the OmniRoute dashboard and update OMNIROUTE_API_KEY in server/.env.')
  }
  if (/\b429\b|rate.?limit|quota|exhausted/i.test(raw)) {
    return new Error('Every provider OmniRoute tried for this model is rate-limited or out of free quota right now. Wait a minute, or pick a different auto model.')
  }
  if (/\b404\b|model.?not.?found|no (healthy|available) (target|provider)/i.test(raw)) {
    return new Error('OmniRoute has no working provider for that model at the moment. Try "OmniRoute auto" or add a provider key in the OmniRoute dashboard.')
  }
  return err instanceof Error ? err : new Error(raw)
}

export async function run(opts) {
  try {
    return await runOpenAICompatible({
      ...opts,
      baseURL: OMNIROUTE_URL(),
      providerName: 'omniroute',
      label: 'OmniRoute',
      defaultModel: 'auto',
    })
  } catch (err) {
    throw friendlyError(err)
  }
}
