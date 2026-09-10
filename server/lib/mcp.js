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

const EXT_TYPES = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image',
  mp4: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio',
}

function kindFromMime(mime = '') {
  if (mime.startsWith('video')) return 'video'
  if (mime.startsWith('audio')) return 'audio'
  if (mime.startsWith('image')) return 'image'
  return 'file'
}

// Generators like Higgsfield don't return the bytes — they return a link to the
// finished render, sometimes as a resource block and sometimes as a bare URL in
// the text ("Here's your video: https://…/out.mp4"). The chat should show the
// result either way, so text is scanned for media URLs too.
function mediaUrlsInText(text = '') {
  const found = []
  const seen = new Set()
  const add = (url, hint) => {
    const clean = String(url).replace(/[.,;]+$/, '')
    if (!/^https?:\/\//.test(clean) || seen.has(clean)) return
    const ext = (clean.split('?')[0].split('.').pop() || '').toLowerCase()
    const type = EXT_TYPES[ext] || hint
    if (!type) return
    seen.add(clean)
    found.push({ type, mimeType: EXT_TYPES[ext] ? `${type}/${ext === 'jpg' ? 'jpeg' : ext}` : `${type}/*`, url: clean })
  }

  // A generator's finished asset often has NO file extension — the CDN link is
  // a bare id — so the key it arrives under is the only clue about what it is.
  // Read those keys before falling back to matching extensions.
  for (const m of text.matchAll(/"([a-z0-9_]*(?:image|thumbnail|photo|picture)[a-z0-9_]*url|url)"\s*:\s*"([^"]+)"/gi)) {
    add(m[2], /video/i.test(m[1]) ? 'video' : 'image')
  }
  for (const m of text.matchAll(/"([a-z0-9_]*(?:video|clip|movie)[a-z0-9_]*url)"\s*:\s*"([^"]+)"/gi)) add(m[2], 'video')
  for (const m of text.matchAll(/"([a-z0-9_]*audio[a-z0-9_]*url)"\s*:\s*"([^"]+)"/gi)) add(m[2], 'audio')

  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) add(m[0], null)
  return found
}

// A tool that QUEUES work and returns a job id has not produced anything yet.
// Left alone the model announced "here it is!" over an image that did not
// exist, because the result read like success. Make the next step explicit.
const QUEUED = /submitted\s+\d+\s+job|job[_ ]?id|use\s+job_status|poll for completion/i
export function queuedJobHint(text = '') {
  if (!QUEUED.test(text)) return ''
  if (/https?:\/\//.test(text)) return '' // a link is already there — it finished
  return (
    '\n\n[IMPORTANT] This only QUEUED the work — nothing has been generated yet and there is ' +
    'no image or video to show. Call job_status with sync:true (and the job id above) to wait for ' +
    'it to finish and get the result URL. Do NOT tell the user it is ready, and do NOT describe ' +
    'the result, until a URL comes back.'
  )
}

// Every image/audio/video in an MCP tool result, in order — a "generate 4
// images" tool returns four content blocks, and showing only the first one
// silently loses the other three.
function extractAllMedia(content = []) {
  const out = []
  for (const c of content) {
    if (c.type === 'image' && c.data) {
      out.push({ type: 'image', mimeType: c.mimeType || 'image/png', base64: c.data })
    } else if (c.type === 'audio' && c.data) {
      out.push({ type: 'audio', mimeType: c.mimeType || 'audio/mpeg', base64: c.data })
    } else if (c.type === 'resource' && c.resource?.uri) {
      const mime = c.resource.mimeType || ''
      out.push({ type: kindFromMime(mime), mimeType: mime || 'application/octet-stream', url: c.resource.uri })
    }
  }
  return out
}

export async function callMcpTool({ url, token, authProvider, name, args }) {
  return withClient(url, { token, authProvider }, async (client) => {
    const result = await client.callTool({ name, arguments: args || {} })
    const text = (result.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    const seen = new Set()
    const mediaList = [...extractAllMedia(result.content), ...mediaUrlsInText(text)]
      .filter((m) => {
        const key = m.url || m.base64?.slice(0, 64)
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
    return { text, media: mediaList[0] || null, mediaList, isError: Boolean(result.isError), raw: result }
  })
}
