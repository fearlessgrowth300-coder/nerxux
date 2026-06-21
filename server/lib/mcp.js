import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Thin wrapper around the MCP TypeScript SDK for connecting to a REMOTE MCP
// server over the Streamable HTTP transport, listing its tools, and calling
// them. Auth modes:
//   - token:        sent as `Authorization: Bearer <token>` (open / static-token servers)
//   - authProvider: full OAuth (the SDK attaches + refreshes tokens) — for
//                   login-based servers like Higgsfield / Notion.

function makeTransport(url, { token, authProvider } = {}) {
  const opts = {}
  if (authProvider) opts.authProvider = authProvider
  else if (token) opts.requestInit = { headers: { Authorization: `Bearer ${token}` } }
  return new StreamableHTTPClientTransport(new URL(url), opts)
}

async function withClient(url, auth, fn) {
  const transport = makeTransport(url, auth)
  const client = new Client({ name: 'nexus-ai', version: '0.1.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    return await fn(client)
  } finally {
    try {
      await client.close()
    } catch {}
  }
}

// Returns true if an error looks like an auth challenge (needs OAuth login).
export function isAuthError(err) {
  const m = (err?.message || '').toLowerCase()
  return (
    err?.name === 'UnauthorizedError' ||
    m.includes('unauthorized') ||
    m.includes('401') ||
    m.includes('invalid_token') ||
    m.includes('www-authenticate')
  )
}

export async function discoverTools({ url, token, authProvider }) {
  return withClient(url, { token, authProvider }, async (client) => {
    const result = await client.listTools()
    return (result.tools || []).map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }))
  })
}

// Pulls the first image/audio/video out of an MCP tool result, if any.
function extractMedia(content = []) {
  for (const c of content) {
    if (c.type === 'image' && c.data) {
      return { type: 'image', mimeType: c.mimeType || 'image/png', base64: c.data }
    }
    if (c.type === 'audio' && c.data) {
      return { type: 'audio', mimeType: c.mimeType || 'audio/mpeg', base64: c.data }
    }
    if (c.type === 'resource' && c.resource?.uri) {
      const mime = c.resource.mimeType || ''
      const t = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : mime.startsWith('image') ? 'image' : 'file'
      return { type: t, mimeType: mime || 'application/octet-stream', url: c.resource.uri }
    }
  }
  return null
}

export async function callMcpTool({ url, token, authProvider, name, args }) {
  return withClient(url, { token, authProvider }, async (client) => {
    const result = await client.callTool({ name, arguments: args || {} })
    const text = (result.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    return { text, media: extractMedia(result.content), isError: Boolean(result.isError), raw: result }
  })
}
