import { ROUTER_MODEL } from '../../shared/models.js'

// The intent router decides how to handle a user message: which task it is,
// which primary/secondary tools to use, and whether to run them as a pipeline.

const VALID_TOOLS = ['claude', 'openai', 'gemini', 'elevenlabs', 'higgsfield']

const ROUTER_SYSTEM = `You are an intent router for an AI hub. Given the user's latest message and the list of connected tools, decide how to fulfil it.
Return ONLY a JSON object (no prose, no code fences) shaped exactly like:
{"task":"short_snake_case_label","primary_tool":"claude|openai|gemini|elevenlabs|higgsfield","secondary_tool":"<one of the same or null>","pipeline":true|false}
Guidance:
- Text/chat/analysis/writing => primary_tool "claude" (or "openai"/"gemini").
- Text-to-speech / voiceover / audio => "elevenlabs".
- Image or video GENERATION => "higgsfield".
- Use pipeline=true with a secondary_tool when one tool should produce content that another then transforms (e.g. write ad copy with claude, then generate a video with higgsfield).
- Prefer connected tools, but if the task fundamentally needs a specific tool, name it even if not connected.`

function parseDecision(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON in router response')
  return JSON.parse(cleaned.slice(start, end + 1))
}

function normalize(decision) {
  const out = {
    task: String(decision.task || 'general_chat').slice(0, 40),
    primary_tool: VALID_TOOLS.includes(decision.primary_tool)
      ? decision.primary_tool
      : 'claude',
    secondary_tool: VALID_TOOLS.includes(decision.secondary_tool)
      ? decision.secondary_tool
      : null,
    pipeline: Boolean(decision.pipeline && decision.secondary_tool),
  }
  if (!out.pipeline) out.secondary_tool = null
  return out
}

// Lightweight heuristic used when no Anthropic key is available.
function heuristicDecision(message) {
  const m = (message || '').toLowerCase()
  const wantsGen = /\b(generate|create|make|produce)\b/.test(m)

  if (/\b(voice|voiceover|speak|narrat|text to speech|tts|audio)\b/.test(m)) {
    return { task: 'text_to_speech', primary_tool: 'elevenlabs', secondary_tool: null, pipeline: false }
  }
  if (wantsGen && /\b(video|clip|reel|ad)\b/.test(m)) {
    // Write copy first (claude), then generate video (higgsfield).
    return { task: 'video_ad', primary_tool: 'claude', secondary_tool: 'higgsfield', pipeline: true }
  }
  if (wantsGen && /\b(image|picture|photo|logo|art|thumbnail)\b/.test(m)) {
    return { task: 'image_generation', primary_tool: 'higgsfield', secondary_tool: null, pipeline: false }
  }
  if (/\b(analyz|summari|describe).*(video|footage|clip)\b/.test(m)) {
    return { task: 'video_analysis', primary_tool: 'gemini', secondary_tool: null, pipeline: false }
  }
  return { task: 'general_chat', primary_tool: 'claude', secondary_tool: null, pipeline: false }
}

// Calls Claude for a routing decision; falls back to the heuristic on any error
// or when no key is available. Returns { decision, source }.
export async function routeIntent({ userMessage, connectedTools = [], anthropicKey }) {
  if (!anthropicKey) {
    return { decision: normalize(heuristicDecision(userMessage)), source: 'heuristic' }
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ROUTER_MODEL,
        max_tokens: 200,
        system: ROUTER_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Connected tools: ${connectedTools.join(', ') || 'none'}\nUser message: ${userMessage}`,
          },
        ],
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 120)}`)
    }

    const data = await res.json()
    const text = data?.content?.[0]?.text || ''
    return { decision: normalize(parseDecision(text)), source: 'claude' }
  } catch (err) {
    // Never let routing break the chat — degrade to the heuristic.
    return {
      decision: normalize(heuristicDecision(userMessage)),
      source: 'heuristic',
      error: err.message,
    }
  }
}

export { VALID_TOOLS }
