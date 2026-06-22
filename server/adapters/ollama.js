// Adapter for models served by a local Ollama instance — including the user's
// OWN fine-tuned model (`nexus-mine`), imported from the Colab fine-tune. Ollama
// exposes an HTTP API on :11434; no API key is needed (it's local).
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'

function composeSystem(systemPrompt = '', skills = []) {
  const parts = []
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  for (const s of skills || []) {
    if (s?.content?.trim()) parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }
  return parts.join('\n\n')
}

// { prompt, systemPrompt, skills, model }  -> normalized response
export async function run({ prompt, systemPrompt, skills, model }) {
  const system = composeSystem(systemPrompt, skills)
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })

  let resp
  try {
    resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || 'nexus-mine', messages, stream: false }),
    })
  } catch (e) {
    throw new Error(
      `Can't reach Ollama at ${OLLAMA_URL}. Is Ollama running? (${e.message})`
    )
  }
  if (!resp.ok) {
    let msg = `Ollama returned ${resp.status}`
    try {
      const j = await resp.json()
      if (j.error) msg = j.error
    } catch {}
    throw new Error(msg)
  }
  const data = await resp.json()
  return {
    ok: true,
    provider: 'ollama',
    type: 'text',
    content: data.message?.content || '',
    model: data.model || model,
  }
}

// Reachability + list of installed Ollama models (for diagnostics).
export async function health() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`)
    if (!r.ok) return { reachable: true, models: [] }
    const j = await r.json()
    return { reachable: true, models: (j.models || []).map((m) => m.name) }
  } catch {
    return { reachable: false, models: [] }
  }
}
