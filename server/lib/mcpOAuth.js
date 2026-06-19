import crypto from 'crypto'
import { supabaseAdmin } from './supabase.js'
import { encrypt, decrypt } from './crypto.js'

// Default callback if a request-derived one isn't supplied (local dev).
export const DEFAULT_CALLBACK =
  process.env.MCP_OAUTH_CALLBACK || 'http://localhost:4000/api/mcp/oauth/callback'

export function decryptTokens(row) {
  if (!row?.oauth_tokens_ciphertext) return null
  try {
    return JSON.parse(
      decrypt({ ciphertext: row.oauth_tokens_ciphertext, iv: row.oauth_tokens_iv, tag: row.oauth_tokens_tag })
    )
  } catch {
    return null
  }
}

function decryptSecret(row) {
  if (!row?.secret_ciphertext) return null
  try {
    return decrypt({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag })
  } catch {
    return null
  }
}

// Builds an OAuthClientProvider (MCP SDK interface) backed by a connector row.
// `redirectUri` should be the public callback for THIS deployment.
export function createProvider(row, { onRedirect, redirectUri } = {}) {
  const callback = redirectUri || row.oauth_redirect || DEFAULT_CALLBACK

  // Pre-registered client (from Advanced settings) takes priority and skips DCR.
  // If a Client ID is set, the optional secret is the OAuth client_secret.
  let client
  if (row.oauth_client_id) {
    const sec = decryptSecret(row)
    client = { client_id: row.oauth_client_id, ...(sec ? { client_secret: sec } : {}) }
  } else {
    client = row.oauth_client || undefined
  }

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
      return callback
    },
    get clientMetadata() {
      const hasSecret = Boolean(client?.client_secret)
      return {
        client_name: 'Nexus AI',
        redirect_uris: [callback],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: hasSecret ? 'client_secret_post' : 'none',
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
