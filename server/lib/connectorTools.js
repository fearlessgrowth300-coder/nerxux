// A connected MCP server can expose a LOT of tools. Higgsfield alone exposes
// 101, whose definitions come to ~41,000 tokens — more than the local model's
// entire 32,768-token context window. Injecting them all meant the tool list
// evicted the conversation: the model never saw the task, and spent its turns
// calling whatever media tool happened to be in front of it.
//
// So connector tools are selected per message: the ones that match what was
// asked are offered directly, and everything else stays discoverable through
// find_connector_tools rather than sitting in the prompt.

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'my', 'me', 'it',
  'is', 'are', 'be', 'do', 'does', 'can', 'you', 'i', 'this', 'that', 'please', 'now',
  'then', 'so', 'from', 'at', 'by', 'as', 'if', 'we', 'us', 'your', 'here', 'give', 'want',
])

function words(text = '') {
  return [...new Set(String(text).toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || [])]
    .filter((w) => !STOP.has(w))
}

// Higgsfield's tools are named generate_image / generate_video / …, so a name
// hit is worth much more than a description hit, which matches loosely.
function score(tool, queryWords) {
  const name = (tool.name || '').toLowerCase()
  const desc = (tool.description || '').toLowerCase().slice(0, 400)
  let s = 0
  for (const w of queryWords) {
    if (name.includes(w)) s += 10
    else if (desc.includes(w)) s += 1
  }
  return s
}

export const FIND_CONNECTOR_TOOLS = {
  name: 'find_connector_tools',
  description:
    'Search the tools provided by connected services (image/video generation, publishing, and so on) ' +
    'when none of the tools already available do what is needed. Returns matching tool names and their ' +
    'arguments; call a tool by its name afterwards.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What you are trying to do, e.g. "generate an image".' } },
    required: ['query'],
  },
}

/**
 * The connector tools worth putting in front of the model for THIS message.
 * Small connectors are passed through untouched; large ones are filtered to
 * what was actually asked for.
 */
export function selectConnectorTools(tools, query, { maxTools = 24, maxChars = 20000 } = {}) {
  if (!tools.length) return { tools: [], trimmed: false }
  if (tools.length <= maxTools && JSON.stringify(tools).length <= maxChars) {
    return { tools, trimmed: false }
  }

  const queryWords = words(query)
  const ranked = tools
    .map((t) => ({ t, s: score(t, queryWords) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)

  const picked = []
  let chars = 0
  for (const { t } of ranked) {
    const size = JSON.stringify(t).length
    if (picked.length >= maxTools || chars + size > maxChars) break
    picked.push(t)
    chars += size
  }
  // Nothing matched: offer none rather than 24 arbitrary media tools for a
  // request about git. find_connector_tools remains the way in.
  return { tools: picked, trimmed: true }
}

/** Human-readable matches for find_connector_tools. */
export function describeMatches(tools, query, limit = 12) {
  const queryWords = words(query)
  const ranked = tools
    .map((t) => ({ t, s: score(t, queryWords) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)

  if (!ranked.length) {
    return `No connected tool matches "${query}". Available tools include: ` +
      tools.slice(0, 25).map((t) => t.name).join(', ') +
      (tools.length > 25 ? `, … ${tools.length - 25} more` : '')
  }
  return ranked.map(({ t }) => {
    const props = t.input_schema?.properties || {}
    const required = t.input_schema?.required || []
    const args = Object.keys(props)
      .map((k) => `${k}${required.includes(k) ? '*' : ''}: ${props[k]?.type || 'any'}`)
      .join(', ')
    return `${t.name}(${args})\n  ${(t.description || '').slice(0, 200)}`
  }).join('\n\n') + '\n\n(* = required. Call the tool by name.)'
}
