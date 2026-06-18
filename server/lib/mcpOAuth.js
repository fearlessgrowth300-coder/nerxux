import crypto from 'crypto'
import { supabaseAdmin } from './supabase.js'
import { encrypt, decrypt } from './crypto.js'

// Callback URL the MCP server redirects to after the user authorizes. Must be
// reachable by the browser; override in prod via MCP_OAUTH_CALLBACK.
export const CALLBACK_URL =
  process.env.MCP_OAUTH_CALLBACK || 'http://localhost:4000/api/mcp/oauth/callback'

export function decryptTokens(row) {
  if (!row?.oauth_tokens_ciphertext) return null
  try {
    return JSON.parse(
      decrypt({
        ciphertext: row.oauth_tokens_ciphertext,
        iv: row.oauth_tokens_iv,
        tag: row.oauth_tokens_tag,
      })
    )
  } catch {
    return null
  }
}

// Builds an OAuthClientProvider (per the MCP SDK interface) backed by a
// connector row. State is loaded into memory and persisted to the DB on each
// save. `onRedirect(url)` captures the authorization URL during the start flow.
export function createProvider(row, { onRedirect } = {}) {
  // User-supplied client (pre-registered) takes priority; otherwise use the
  // dynamically registered client saved during a prior handshake.
  let client =
    row.oauth_client ||
    (row.oauth_client_id
      ? { client_id: row.oauth_client_id }
      : undefined)
  let verifier = row.oauth_verifier || undefined
  let state = row.oauth_state || undefined
  let tokens = decryptTokens(row) || undefined

  async function persist(fields) {
    await supabaseAdmin
      .from('mcp_connectors')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', row.id)
  }

  const provider = {
    get redirectUrl() {
      return CALLBACK_URL
    },
    get clientMetadata() {
      return {
        client_name: 'Nexus AI',
        redirect_uris: [CALLBACK_URL],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }
    },
    async state() {
      if (!state) {
        state = crypto.randomBytes(16).toString('hex')
        await persist({ oauth_state: state })
      }
      return state
    },
    clientInformation() {
      return client
    },
    async saveClientInformation(info) {
      client = info
      await persist({ oauth_client: info })
    },
    tokens() {
      return tokens
    },
    async saveTokens(t) {
      tokens = t
      const enc = encrypt(JSON.stringify(t))
      await persist({
        oauth_tokens_ciphertext: enc.ciphertext,
        oauth_tokens_iv: enc.iv,
        oauth_tokens_tag: enc.tag,
        last_status: 'connected',
        last_error: null,
      })
    },
    async redirectToAuthorization(url) {
      if (onRedirect) await onRedirect(url.toString())
    },
    async saveCodeVerifier(v) {
      verifier = v
      await persist({ oauth_verifier: v })
    },
    codeVerifier() {
      if (!verifier) throw new Error('Missing PKCE code verifier')
      return verifier
    },
  }

  return { provider, hasTokens: () => Boolean(tokens) }
}
