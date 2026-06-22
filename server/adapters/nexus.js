// Adapter for "Nexus (your model)" — the from-scratch GPT trained locally by the
// nexus-model engine. It talks to that engine's HTTP server (serve.py), so no
// external provider or API key is involved: this is YOUR model running on YOUR
// machine. Start it with:  cd nexus-model && python serve.py
// 127.0.0.1, not "localhost": on Windows Node resolves localhost to IPv6 ::1
// first, which can fail to reach an IPv4-bound local server.
const MODEL_URL = process.env.NEXUS_MODEL_URL || 'http://127.0.0.1:4500'

function composeSystem(systemPrompt = '', skills = []) {
  const parts = []
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  for (const s of skills || []) {
    if (s?.content?.trim()) parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }
  return parts.join('\n\n')
}

// { prompt, systemPrompt, skills, temperature?, maxTokens? }
export async function run({ prompt, systemPrompt, skills, temperature, maxTokens }) {
  const system = composeSystem(systemPrompt, skills)
  let resp
  try {
    resp = await fetch(`${MODEL_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        system,
        temperature: temperature ?? 0.8,
        max_tokens: maxTokens ?? 160,
      }),
    })
  } catch (e) {
    throw new Error(
      `Can't reach your local model at ${MODEL_URL}. Start it with: cd nexus-model && python serve.py (${e.message})`
    )
  }
  if (!resp.ok) {
    let msg = `Model server returned ${resp.status}`
    try {
      const j = await resp.json()
      if (j.error) msg = j.error
    } catch {}
    throw new Error(msg)
  }
  const data = await resp.json()
  return {
    ok: true,
    provider: 'nexus',
    type: 'text',
    content: data.content || '',
    model: data.model || 'nexus-local',
  }
}

// Lightweight reachability check used by the Train page.
export async function health() {
  try {
    const r = await fetch(`${MODEL_URL}/health`, { method: 'GET' })
    if (!r.ok) return { reachable: true, loaded: false }
    const j = await r.json()
    return { reachable: true, loaded: !!j.loaded, params: j.params || 0 }
  } catch {
    return { reachable: false, loaded: false }
  }
}
