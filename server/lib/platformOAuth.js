// Platform OAuth apps configured ONCE by the app owner, so every user can
// connect their OWN account (like Claude) without registering their own app.
//
// For each service the owner registers a single OAuth app at the provider,
// adds the app's redirect URI ( <host>/api/mcp/oauth/callback for MCP,
// <host>/api/native/oauth/callback for native ), and sets the client
// id/secret in the server environment below.

// MCP services keyed by a host substring of the MCP server URL.
const MCP_APPS = [
  { match: 'facebook.com', idEnv: 'FACEBOOK_OAUTH_CLIENT_ID', secretEnv: 'FACEBOOK_OAUTH_CLIENT_SECRET' },
  { match: 'notion.com', idEnv: 'NOTION_OAUTH_CLIENT_ID', secretEnv: 'NOTION_OAUTH_CLIENT_SECRET' },
  { match: 'linear.app', idEnv: 'LINEAR_OAUTH_CLIENT_ID', secretEnv: 'LINEAR_OAUTH_CLIENT_SECRET' },
]

function readApp(idEnv, secretEnv) {
  const client_id = process.env[idEnv]
  const client_secret = process.env[secretEnv]
  if (client_id && client_id.trim() && client_secret && client_secret.trim()) {
    return { client_id: client_id.trim(), client_secret: client_secret.trim() }
  }
  return null
}

// Returns { client_id, client_secret } if the owner configured a platform app
// for this MCP server URL, else null.
export function platformOAuthForUrl(url) {
  let host = ''
  try { host = new URL(url).host.toLowerCase() } catch {}
  for (const a of MCP_APPS) {
    if (host.includes(a.match)) {
      const app = readApp(a.idEnv, a.secretEnv)
      if (app) return app
    }
  }
  return null
}

export function hasPlatformOAuthForUrl(url) {
  return Boolean(platformOAuthForUrl(url))
}

// Native providers (own OAuth + REST API), keyed by provider id.
const NATIVE_APPS = {
  youtube: { idEnv: 'GOOGLE_CLIENT_ID', secretEnv: 'GOOGLE_CLIENT_SECRET' },
  facebook: { idEnv: 'FACEBOOK_OAUTH_CLIENT_ID', secretEnv: 'FACEBOOK_OAUTH_CLIENT_SECRET' },
}

export function platformOAuthForNative(provider) {
  const a = NATIVE_APPS[provider]
  return a ? readApp(a.idEnv, a.secretEnv) : null
}

export function hasPlatformOAuthForNative(provider) {
  return Boolean(platformOAuthForNative(provider))
}
