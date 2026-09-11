// Adapter for "Nexus (your model)" — the from-scratch GPT trained locally by the
// nexus-model engine. It talks to that engine's HTTP server (serve.py), so no
// external provider or API key is involved: this is YOUR model running on YOUR
// machine. The Node API auto-starts serve.py; this adapter also SELF-HEALS — if
// the model server is down when a chat arrives, it starts it and retries.
// 127.0.0.1, not "localhost": on Windows Node resolves localhost to IPv6 ::1
// first, which can fail to reach an IPv4-bound local server.
import { ensureModelServer, hasCheckpoint } from '../lib/modelServer.js'

const MODEL_URL = process.env.NEXUS_MODEL_URL || 'http://127.0.0.1:4500'
export const NO_CHECKPOINT_MESSAGE =
  'This experimental model has no trained weights on this server, so it cannot answer. ' +
  'Open the model picker and switch model A to "Qwen 3.8 27B Uncensored" (or another model) to continue.'

function composeSystem(systemPrompt = '', skills = []) {
  const parts = []
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  for (const s of skills || []) {
    if (s?.content?.trim()) parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }
  return parts.join('\n\n')
}

function postChat(body) {
  return fetch(`${MODEL_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// { prompt, systemPrompt, skills, temperature?, maxTokens? }
export async function run({ prompt, systemPrompt, skills, temperature, maxTokens }) {
  // Fail in milliseconds, not after a real network timeout plus a doomed
  // auto-start attempt, and say something the user can actually act on — the
  // previous message told them to open a terminal on a server they don't have.
  if (!hasCheckpoint()) throw new Error(NO_CHECKPOINT_MESSAGE)
  const system = composeSystem(systemPrompt, skills)
  const body = { prompt, system, temperature: temperature ?? 0.8, max_tokens: maxTokens ?? 160 }

  let resp
  try {
    resp = await postChat(body)
  } catch (e) {
    // Model server appears down — auto-start it and retry once.
    await ensureModelServer()
    try {
      resp = await postChat(body)
    } catch (e2) {
      throw new Error(
        `Can't reach your local model at ${MODEL_URL}, and auto-start failed. ` +
        `Run it manually: cd nexus-model && python serve.py (${e2.message})`
      )
    }
  }
  if (!resp.ok) {
    let msg = `Model server returned ${resp.status}`
    try {
      const j = await resp.json()
      const raw = j.reply || j.error
      if (raw) msg = typeof raw === 'string' ? raw : raw.message || JSON.stringify(raw)
    } catch {}
    throw new Error(msg)
  }
  const data = await resp.json()
  return {
    ok: true,
    provider: 'nexus',
    type: 'text',
    content: data.content || data.reply || '',
    model: data.model || 'nexus-local',
  }
}

// Lightweight reachability check used by the Train page. Tries to auto-start the
// model server if it's not reachable, so the Train page recovers on its own.
export async function health() {
  if (!hasCheckpoint()) return { reachable: false, loaded: false, message: NO_CHECKPOINT_MESSAGE }
  try {
    const r = await fetch(`${MODEL_URL}/health`, { method: 'GET' })
    if (!r.ok) return { reachable: true, loaded: false }
    const j = await r.json()
    return { reachable: true, loaded: !!(j.model_loaded ?? j.loaded), params: j.params || 0 }
  } catch {
    ensureModelServer().catch(() => {})  // kick off a start in the background
    return { reachable: false, loaded: false }
  }
}
