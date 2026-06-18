import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Thin wrapper around the MCP TypeScript SDK for connecting to a REMOTE MCP
// server over the Streamable HTTP transport, listing its tools, and calling
// them. Auth: if a bearer token (the optional OAuth secret) is provided, it's
// sent as `Authorization: Bearer <token>` — this covers open servers and
// static-token servers. Full OAuth authorization-code flow is a future add.

function makeTransport(url, token) {
  const requestInit = {}
  if (token) {
    requestInit.headers = { Authorization: `Bearer ${token}` }
  }
  return new StreamableHTTPClientTransport(new URL(url), { requestInit })
}

async function withClient(url, token, fn) {
  const transport = makeTransport(url, token)
  const client = new Client(
    { name: 'nexus-ai', version: '0.1.0' },
    { capabilities: {} }
  )
  try {
    await client.connect(transport)
    return await fn(client)
  } finally {
    try {
      await client.close()
    } catch {}
  }
}

// Connects and returns the server's tools as a normalized array
// [{ name, description, inputSchema }]. Throws on connection/auth failure.
export async function discoverTools({ url, token }) {
  return withClient(url, token, async (client) => {
    const result = await client.listTools()
    return (result.tools || []).map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }))
  })
}

// Calls a single tool and returns its result content (flattened to text where
// possible, with the raw result attached).
export async function callMcpTool({ url, token, name, args }) {
  return withClient(url, token, async (client) => {
    const result = await client.callTool({ name, arguments: args || {} })
    const text = (result.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    return { text, isError: Boolean(result.isError), raw: result }
  })
}
