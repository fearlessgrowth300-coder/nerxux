// Generic web search backed by the Brave Search API — for providers with no
// search of their own built in (Groq, the local Ollama/nexus models). Claude
// (native web_search tool), Gemini (native grounding) and GPT-4o (Responses
// API web_search_preview) already have real search and don't use this.
const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search'

export function hasBraveKey() {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim())
}

// Anthropic/MCP-shaped tool definition — reused (with light reshaping) by
// whichever adapter's tool-calling format needs it.
export const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description: 'Search the live web for current information and return real results (title, URL, snippet). Use this for anything that needs up-to-date or factual information you are not certain of.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
}

export async function braveSearch(query, count = 5) {
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim()
  if (!key) throw new Error('Web search is not configured (no BRAVE_SEARCH_API_KEY on the server).')
  const q = String(query || '').trim()
  if (!q) throw new Error('web_search needs a query')

  const url = new URL(BRAVE_URL)
  url.searchParams.set('q', q)
  url.searchParams.set('count', String(Math.min(Math.max(count, 1), 10)))

  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  })
  if (!resp.ok) {
    if (resp.status === 401) throw new Error('Brave Search rejected the API key (BRAVE_SEARCH_API_KEY).')
    if (resp.status === 429) throw new Error('Brave Search rate limit hit — wait a moment and try again.')
    throw new Error(`Brave Search returned ${resp.status}`)
  }
  const data = await resp.json()
  return (data.web?.results || []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    description: (r.description || '').replace(/<\/?strong>/g, ''),
  }))
}

// Executes the tool for any adapter: returns { content } text ready to feed
// back to the model as the tool's observation.
export async function runWebSearchTool({ query } = {}) {
  try {
    const results = await braveSearch(query)
    if (!results.length) return { content: `No web results for "${query}".` }
    const text = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
      .join('\n\n')
    return { content: `Web search results for "${query}":\n\n${text}` }
  } catch (e) {
    return { content: `Web search failed: ${e.message}` }
  }
}
