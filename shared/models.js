// Shared model + provider registry used by both the client (dropdowns) and the
// server (adapter routing). Keeping this in /shared avoids drift between the
// UI's available models and what the backend actually knows how to call.

export const PROVIDERS = {
  claude: { id: 'claude', label: 'Claude (Anthropic)' },
  openai: { id: 'openai', label: 'OpenAI' },
  gemini: { id: 'gemini', label: 'Google Gemini' },
  groq: { id: 'groq', label: 'Groq (Llama 4 / DeepSeek / Qwen3 — fast)' },
  // Gateway on the VPS (127.0.0.1:20128): one key, many providers incl. free
  // tiers, automatic fallback. Its key is a platform key (OMNIROUTE_API_KEY).
  omniroute: { id: 'omniroute', label: 'OmniRoute (free AI gateway on the VPS)' },
  elevenlabs: { id: 'elevenlabs', label: 'ElevenLabs' },
  higgsfield: { id: 'higgsfield', label: 'Higgsfield' },
  // Not a chat model — a credential the agent's sandbox tool uses to
  // authenticate `git clone`/`git push`. Lives in the same encrypted vault
  // and Connections UI as the model API keys for consistency.
  github: { id: 'github', label: 'GitHub' },
}

// The user's own locally-trained model. It needs no API key (the server's nexus
// adapter calls the local model server), so it is intentionally NOT in PROVIDERS
// — that keeps it off the Connections/vault page. Routing uses the adapter map.
export const LOCAL_PROVIDER = 'nexus'

// Chat-capable models surfaced in the Model A / Model B selectors (Step 8).
export const CHAT_MODELS = [
  {
    id: 'claude-sonnet',
    label: 'Claude Sonnet',
    provider: 'claude',
    apiModel: 'claude-sonnet-4-6',
    vision: true,
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    provider: 'openai',
    apiModel: 'gpt-4o',
    vision: true,
  },
  {
    id: 'gemini-1.5-pro',
    label: 'Gemini 1.5 Pro',
    provider: 'gemini',
    apiModel: 'gemini-1.5-pro',
    vision: true,
  },
  {
    id: 'gemini-2.0-flash',
    label: 'Gemini 2.0 Flash',
    provider: 'gemini',
    apiModel: 'gemini-2.0-flash',
    vision: true,
  },
  // ---- OmniRoute: the VPS gateway picks a working (often free) provider ----
  // auto/* are OmniRoute's own routing profiles; it falls back to the next
  // provider when one is down or out of quota.
  { id: 'omniroute-best-coding', label: 'OmniRoute auto: best coding (free gateway)', provider: 'omniroute', apiModel: 'auto/best-coding', vision: false },
  { id: 'omniroute-best-reasoning', label: 'OmniRoute auto: best reasoning (free gateway)', provider: 'omniroute', apiModel: 'auto/best-reasoning', vision: false },
  { id: 'omniroute-fast', label: 'OmniRoute auto: fast (free gateway)', provider: 'omniroute', apiModel: 'auto/best-fast', vision: false },
  { id: 'omniroute-auto', label: 'OmniRoute auto (free gateway)', provider: 'omniroute', apiModel: 'auto', vision: false },
  // ---- Groq: open models on LPU hardware, ~free (30 req/min), very fast ----
  // Model ids track console.groq.com/docs/models; Groq rotates its lineup, so if
  // one 404s the adapter says so and you swap it here.
  {
    id: 'groq-llama4-scout',
    label: 'Llama 4 Scout (Groq) — fast, vision',
    provider: 'groq',
    apiModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    vision: true,
  },
  {
    id: 'groq-llama-3.3-70b',
    label: 'Llama 3.3 70B (Groq) — fast',
    provider: 'groq',
    apiModel: 'llama-3.3-70b-versatile',
    vision: false,
  },
  {
    id: 'groq-deepseek-r1',
    label: 'DeepSeek R1 70B (Groq) — reasoning',
    provider: 'groq',
    apiModel: 'deepseek-r1-distill-llama-70b',
    vision: false,
  },
  {
    id: 'groq-qwen3-32b',
    label: 'Qwen3 32B (Groq) — fast',
    provider: 'groq',
    apiModel: 'qwen/qwen3-32b',
    vision: false,
  },
  {
    id: 'groq-gemma2-9b',
    label: 'Gemma 2 9B (Groq) — fast',
    provider: 'groq',
    apiModel: 'gemma2-9b-it',
    vision: false,
  },
  {
    id: 'groq-llama-3.1-8b',
    label: 'Llama 3.1 8B (Groq) — instant',
    provider: 'groq',
    apiModel: 'llama-3.1-8b-instant',
    vision: false,
  },
  {
    // Your own model — a from-scratch GPT trained locally by nexus-model/.
    // No API key; the server's nexus adapter calls the local model server.
    id: 'nexus-local',
    label: 'Nexus (from-scratch) — experimental',
    provider: 'nexus',
    apiModel: 'nexus-local',
    vision: false,
  },
  {
    // Your FINE-TUNED model — an open base (Qwen2.5) trained on YOUR data,
    // imported into Ollama as `nexus-mine`. Coherent — chats/codes for real.
    id: 'nexus-mine',
    label: 'Nexus Pro (fine-tuned) — works',
    provider: 'ollama',
    apiModel: 'nexus-mine',
    vision: false,
  },
  {
    // Strong local coder models you already have in Ollama (no API key).
    id: 'qwen-coder-1_5b',
    label: 'Coder 1.5B (local)',
    provider: 'ollama',
    apiModel: 'qwen2.5-coder:1.5b',
    vision: false,
  },
  {
    // Turbo (RunPod GPU) runs this 27B on Ollama. Always On (VPS CPU) runs
    // Qwen3.8 27B HauhauCS Aggressive + FastMTP on llama-server (ALWAYS_ON_API=openai,
    // server/lib/llamaServerChat.js). The id stays the same so saved chats keep working.
    id: 'qwen3-8-runpod',
    label: 'Qwen 3.8 27B Uncensored (Turbo · Always On: HauhauCS + MTP)',
    provider: 'ollama',
    apiModel: 'orcarouter/Qwen3.8-27B-Uncensored:latest',
    vision: false,
  },
  {
    id: 'qwen-coder-7b',
    label: 'Coder 7B (local, best)',
    provider: 'ollama',
    apiModel: 'qwen2.5-coder:7b',
    vision: false,
  },
]

// Live-fetched models (see server/lib/liveModels.js) use a composite id —
// "provider/apiModel" — instead of a curated slug, so a model neither side
// hardcoded still routes correctly: parse it directly rather than requiring
// a static table entry. Plain slugs (no "/") still resolve from CHAT_MODELS.
export const getModelById = (id) => {
  if (typeof id === 'string' && id.includes('/')) {
    const provider = id.slice(0, id.indexOf('/'))
    const apiModel = id.slice(id.indexOf('/') + 1)
    if (provider && apiModel) return { id, provider, apiModel, label: apiModel }
  }
  return CHAT_MODELS.find((m) => m.id === id) || null
}

// Model used for the lightweight intent router (Step 10).
export const ROUTER_MODEL = 'claude-sonnet-4-6'

// The adviser that reviews the local agent's execution record and says what to
// try next (lib/advisor.js). A stronger model than the one doing the work, on
// purpose: it runs a few times per turn on a few hundred tokens of state, so
// the cost is small next to the tool actions it saves.
//
// Whichever of these the user actually has connected is used, in this order —
// tying it to one provider meant an adviser that silently never ran. Each is
// overridable without a deploy.
export const ADVISOR_MODELS = [
  { provider: 'claude', model: process.env.NEXUS_ADVISOR_CLAUDE || 'claude-sonnet-5' },
  { provider: 'openai', model: process.env.NEXUS_ADVISOR_OPENAI || 'gpt-5' },
  { provider: 'gemini', model: process.env.NEXUS_ADVISOR_GEMINI || 'gemini-3.8-flash' },
]
