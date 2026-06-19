import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { supabaseAdmin } from './supabase.js'
import { encrypt, decrypt } from './crypto.js'
import { discoverTools, isAuthError } from './mcp.js'
import { createProvider, decryptTokens } from './mcpOAuth.js'

function decryptStaticSecret(row) {
  if (!row.secret_ciphertext) return null
  return decrypt({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag })
}

function publicRow(row) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    oauth_client_id: row.oauth_client_id || null,
    hasSecret: Boolean(row.secret_ciphertext),
    authorized: Boolean(row.oauth_tokens_ciphertext),
    tools: row.tools || [],
    toolCount: (row.tools || []).length,
    toolPerms: row.tool_perms || {},
    enabled: row.enabled,
    status: row.last_status,
    error: row.last_error || null,
    updated_at: row.updated_at,
  }
}

// Sets a per-tool permission: 'allow' | 'approval' | 'blocked'.
export async function setToolPermission(userId, id, toolName, perm) {
  const row = await getRow(userId, id)
  const perms = { ...(row.tool_perms || {}), [toolName]: perm }
  const { data, error } = await supabaseAdmin
    .from('mcp_connectors')
    .update({ tool_perms: perms, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return publicRow(data)
}

async function getRow(userId, id) {
  const { data, error } = await supabaseAdmin
    .from('mcp_connectors')
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Connector not found')
  return data
}

// Chooses the right auth for a connector: OAuth tokens > static bearer > none.
function authFor(row) {
  if (row.oauth_tokens_ciphertext) {
    const { provider } = createProvider(row)
    return { authProvider: provider }
  }
  if (row.secret_ciphertext && !row.oauth_client_id) {
    return { token: decryptStaticSecret(row) }
  }
  return {}
}

// Attempts to connect + list tools, classifying the outcome.
async function probe(row) {
  try {
    const tools = await discoverTools({ url: row.url, ...authFor(row) })
    return { tools, status: 'connected', error: null }
  } catch (e) {
    if (isAuthError(e)) {
      return {
        tools: row.tools || [],
        status: 'needs_auth',
        error: 'Authorization required — click Connect to sign in.',
      }
    }
    return { tools: row.tools || [], status: 'error', error: e.message }
  }
}

export async function listConnectors(userId) {
  const { data, error } = await supabaseAdmin
    .from('mcp_connectors')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data || []).map(publicRow)
}

export async function addConnector(userId, { name, url, oauthClientId, oauthSecret }) {
  if (!name?.trim()) throw new Error('Name is required')
  if (!url?.trim()) throw new Error('Remote MCP server URL is required')

  const secretEnc = oauthSecret?.trim() ? encrypt(oauthSecret.trim()) : null

  // Insert first so we have a row id (needed for the OAuth provider/state).
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('mcp_connectors')
    .insert({
      user_id: userId,
      name: name.trim(),
      url: url.trim(),
      oauth_client_id: oauthClientId?.trim() || null,
      secret_ciphertext: secretEnc?.ciphertext || null,
      secret_iv: secretEnc?.iv || null,
      secret_tag: secretEnc?.tag || null,
      tools: [],
      enabled: true,
      last_status: 'unknown',
    })
    .select()
    .single()
  if (insErr) throw insErr

  const result = await probe(inserted)
  const { data, error } = await supabaseAdmin
    .from('mcp_connectors')
    .update({
      tools: result.tools,
      last_status: result.status,
      last_error: result.error,
      updated_at: new Date().toISOString(),
    })
    .eq('id', inserted.id)
    .select()
    .single()
  if (error) throw error
  return publicRow(data)
}

export async function refreshConnector(userId, id) {
  const row = await getRow(userId, id)
  const result = await probe(row)
  const { data, error } = await supabaseAdmin
    .from('mcp_connectors')
    .update({
      tools: result.tools,
      last_status: result.status,
      last_error: result.error,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return publicRow(data)
}

// Turns low-level OAuth errors into an actionable message.
function friendlyAuthError(e) {
  const m = (e?.message || '').toLowerCase()
  if (
    m.includes('registration') ||
    m.includes('not available') ||
    m.includes('incompatible auth server') ||
    m.includes('must be saveable')
  ) {
    return (
      "This server doesn't allow automatic app registration. Open the connector's " +
      'Advanced settings, paste an OAuth Client ID (and Secret) from the provider, then Connect.'
    )
  }
  return e?.message || 'Authorization failed'
}

// Begins the OAuth flow: returns { authUrl } to open in the browser, or
// { authorized: true } if valid tokens already exist. `redirectUri` is the
// public callback for this deployment (derived from the request).
export async function startOAuth(userId, id, redirectUri) {
  const row = await getRow(userId, id)

  // Reset transient handshake state; re-register fresh (DCR) when not yet
  // connected and not using a pre-registered client, so the redirect_uri matches.
  const reset = { oauth_state: null, oauth_verifier: null, oauth_redirect: redirectUri }
  if (!row.oauth_client_id && !row.oauth_tokens_ciphertext) reset.oauth_client = null
  await supabaseAdmin
    .from('mcp_connectors')
    .update({ ...reset, updated_at: new Date().toISOString() })
    .eq('id', id)
  const fresh = await getRow(userId, id)

  let authUrl = null
  const { provider } = createProvider(fresh, { redirectUri, onRedirect: (u) => { authUrl = u } })
  let result
  try {
    result = await auth(provider, { serverUrl: fresh.url })
  } catch (e) {
    throw new Error(friendlyAuthError(e))
  }
  if (result === 'AUTHORIZED') {
    const connector = await refreshConnector(userId, id)
    return { authorized: true, connector }
  }
  if (!authUrl) throw new Error('The MCP server did not return an authorization URL')
  return { authUrl }
}

// Completes the OAuth flow from the callback: exchanges the code for tokens,
// then discovers the server's tools.
export async function completeOAuth(state, code) {
  const { data: row, error } = await supabaseAdmin
    .from('mcp_connectors')
    .select('*')
    .eq('oauth_state', state)
    .maybeSingle()
  if (error) throw error
  if (!row) throw new Error('Invalid or expired authorization state')

  const { provider } = createProvider(row, { redirectUri: row.oauth_redirect })
  await auth(provider, { serverUrl: row.url, authorizationCode: code }) // saves tokens

  // Re-read to pick up saved tokens, then list tools.
  const fresh = await getRow(row.user_id, row.id)
  let tools = []
  let status = 'connected'
  let lastError = null
  try {
    const { provider: p2 } = createProvider(fresh, { redirectUri: fresh.oauth_redirect })
    tools = await discoverTools({ url: fresh.url, authProvider: p2 })
  } catch (e) {
    status = 'error'
    lastError = e.message
  }
  await supabaseAdmin
    .from('mcp_connectors')
    .update({
      tools,
      last_status: status,
      last_error: lastError,
      oauth_state: null,
      oauth_verifier: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)

  return { name: row.name, status }
}

export async function setConnectorEnabled(userId, id, enabled) {
  const { data, error } = await supabaseAdmin
    .from('mcp_connectors')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return publicRow(data)
}

export async function deleteConnector(userId, id) {
  const { error } = await supabaseAdmin
    .from('mcp_connectors')
    .delete()
    .eq('user_id', userId)
    .eq('id', id)
  if (error) throw error
}

// For chat: enabled connectors with their tools + the auth needed to call them.
export async function getEnabledConnectors(userId) {
  const { data, error } = await supabaseAdmin
    .from('mcp_connectors')
    .select('*')
    .eq('user_id', userId)
    .eq('enabled', true)
  if (error) throw error
  return (data || []).map((row) => {
    const perms = row.tool_perms || {}
    // Exclude blocked tools from what the model can call.
    const tools = (row.tools || []).filter((t) => perms[t.name] !== 'blocked')
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      tools,
      ...authFor(row),
    }
  })
}
