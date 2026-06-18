import { supabaseAdmin } from './supabase.js'
import { encrypt, decrypt } from './crypto.js'
import { discoverTools } from './mcp.js'

// Strips secret columns before returning a connector to the client.
function publicRow(row) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    oauth_client_id: row.oauth_client_id || null,
    hasSecret: Boolean(row.secret_ciphertext),
    tools: row.tools || [],
    toolCount: (row.tools || []).length,
    enabled: row.enabled,
    status: row.last_status,
    error: row.last_error || null,
    updated_at: row.updated_at,
  }
}

function decryptSecret(row) {
  if (!row.secret_ciphertext) return null
  return decrypt({
    ciphertext: row.secret_ciphertext,
    iv: row.secret_iv,
    tag: row.secret_tag,
  })
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

// Adds a connector: tries to connect + discover tools, then persists.
export async function addConnector(userId, { name, url, oauthClientId, oauthSecret }) {
  if (!name?.trim()) throw new Error('Name is required')
  if (!url?.trim()) throw new Error('Remote MCP server URL is required')

  const secretEnc = oauthSecret?.trim() ? encrypt(oauthSecret.trim()) : null

  // Attempt a live connection so we can store the discovered tools + status.
  let tools = []
  let status = 'connected'
  let lastError = null
  try {
    tools = await discoverTools({ url: url.trim(), token: oauthSecret?.trim() || null })
  } catch (e) {
    status = 'error'
    lastError = e.message
  }

  const { data, error } = await supabaseAdmin
    .from('mcp_connectors')
    .insert({
      user_id: userId,
      name: name.trim(),
      url: url.trim(),
      oauth_client_id: oauthClientId?.trim() || null,
      secret_ciphertext: secretEnc?.ciphertext || null,
      secret_iv: secretEnc?.iv || null,
      secret_tag: secretEnc?.tag || null,
      tools,
      enabled: true,
      last_status: status,
      last_error: lastError,
    })
    .select()
    .single()
  if (error) throw error
  return publicRow(data)
}

export async function refreshConnector(userId, id) {
  const { data: row, error: e1 } = await supabaseAdmin
    .from('mcp_connectors')
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle()
  if (e1) throw e1
  if (!row) throw new Error('Connector not found')

  let tools = row.tools || []
  let status = 'connected'
  let lastError = null
  try {
    tools = await discoverTools({ url: row.url, token: decryptSecret(row) })
  } catch (e) {
    status = 'error'
    lastError = e.message
  }

  const { data, error } = await supabaseAdmin
    .from('mcp_connectors')
    .update({ tools, last_status: status, last_error: lastError, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return publicRow(data)
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

// For chat: returns enabled connectors with decrypted tokens + their tools, so
// the chat route can expose MCP tools to the model and route tool calls back.
export async function getEnabledConnectors(userId) {
  const { data, error } = await supabaseAdmin
    .from('mcp_connectors')
    .select('*')
    .eq('user_id', userId)
    .eq('enabled', true)
  if (error) throw error
  return (data || []).map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    token: decryptSecret(row),
    tools: row.tools || [],
  }))
}
