// Shared model + provider registry used by both the client (dropdowns) and the
// server (adapter routing). Keeping this in /shared avoids drift between the
// UI's available models and what the backend actually knows how to call.

export const PROVIDERS = {
  claude: { id: 'claude', label: 'Claude (Anthropic)' },
  openai: { id: 'openai', label: 'OpenAI' },
  gemini: { id: 'gemini', label: 'Google Gemini' },
  elevenlabs: { id: 'elevenlabs', label: 'ElevenLabs' },
  higgsfield: { id: 'higgsfield', label: 'Higgsfield' },
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
  {
    // Your own model — a from-scratch GPT trained locally by nexus-model/.
    // No API key; the server's nexus adapter calls the local model server.
    id: 'nexus-local',
    label: 'Nexus (your model)',
    provider: 'nexus',
    apiModel: 'nexus-local',
    vision: false,
  },
]

export const getModelById = (id) => CHAT_MODELS.find((m) => m.id === id) || null

// Model used for the lightweight intent router (Step 10).
export const ROUTER_MODEL = 'claude-sonnet-4-6'
