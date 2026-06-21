import crypto from 'crypto'
import { supabaseAdmin } from './supabase.js'
import { encrypt, decrypt } from './crypto.js'
import { buildAuthUrl, exchangeCode, refreshAccessToken, getMyChannel } from './google.js'
import { platformOAuthForNative } from './platformOAuth.js'

function encField(value) {
  if (!value) return { c: null, i: null, t: null }
  const e = encrypt(value)
  return { c: e.ciphertext, i: e.iv, t: e.tag }
}
function decField(c, i, t) {
  if (!c) return null
  try {
    return decrypt({ ciphertext: c, iv: i, tag: t })
  } catch {
    return null
  }
}

function publicRow(row) {
  return {
    provider: row.provider,
    connected: row.status === 'connected',
    status: row.status,
    meta: row.meta || {},
    updated_at: row.updated_at,
  }
}

export async function listNative(userId) {
  const { data, error } = await supabaseAdmin
    .from('native_connections')
    .select('*')
    .eq('user_id', userId)
  if (error) throw error
  return (data || []).map(publicRow)
}

async function getRow(userId, provider) {
  const { data, error } = await supabaseAdmin
    .from('native_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle()
  if (error) throw error
  return data
}

// Stores the provider OAuth app credentials and returns the authorization URL.
export async function startConnect(userId, provider, { clientId, clientSecret, redirectUri }) {
  let cid = clientId?.trim()
  let csec = clientSecret?.trim()
  let usingPlatform = false

  // Fall back to the owner-configured platform OAuth app so users connect their
  // OWN account with no setup (like Claude).
  if (!cid || !csec) {
    const plat = platformOAuthForNative(provider)
    if (plat) { cid = plat.client_id; csec = plat.client_secret; usingPlatform = true }
  }
  if (!cid || !csec) {
    throw new Error('This integration isn’t set up yet. Ask the app owner to configure it, or add your own Client ID/Secret.')
  }

  const state = crypto.randomBytes(16).toString('hex')
  // Only persist the secret when it's the user's own. The platform secret stays
  // in the server env and is re-read when exchanging/refreshing tokens.
  const sec = usingPlatform ? { c: null, i: null, t: null } : encField(csec)

  await supabaseAdmin.from('native_connections').upsert(
    {
      user_id: userId,
      provider,
      client_id: cid,
      secret_ciphertext: sec.c,
      secret_iv: sec.i,
      secret_tag: sec.t,
      oauth_state: state,
      oauth_redirect: redirectUri,
      status: 'connecting',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,provider' }
  )

  const SCOPES = provider === 'youtube'
    ? ['https://www.googleapis.com/auth/youtube.readonly']
    : ['https://www.googleapis.com/auth/youtube.readonly']

  return buildAuthUrl({ clientId: cid, redirectUri, state, scopes: SCOPES })
}

// Resolves the client secret for a row: the user's stored secret, else the
// platform secret from env (when the connection uses the platform app).
function secretFor(row) {
  return decField(row.secret_ciphertext, row.secret_iv, row.secret_tag)
    || platformOAuthForNative(row.provider)?.client_secret
    || null
}

// Completes the OAuth callback: exchanges the code, stores tokens, fetches meta.
export async function completeConnect(state, code) {
  const { data: row, error } = await supabaseAdmin
    .from('native_connections')
    .select('*')
    .eq('oauth_state', state)
    .maybeSingle()
  if (error) throw error
  if (!row) throw new Error('Invalid or expired authorization state')

  const tokens = await exchangeCode({
    clientId: row.client_id,
    clientSecret: secretFor(row),
    code,
    redirectUri: row.oauth_redirect,
  })

  const stored = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry: Date.now() + (tokens.expires_in || 3600) * 1000 - 60000,
  }
  const enc = encField(JSON.stringify(stored))

  // Fetch channel meta for display.
  let meta = {}
  try {
    const ch = await getMyChannel(tokens.access_token)
    if (ch?.title) meta = { channel: ch.title, subscribers: ch.stats?.subscriberCount, videos: ch.stats?.videoCount }
  } catch {}

  await supabaseAdmin
    .from('native_connections')
    .update({
      tokens_ciphertext: enc.c,
      tokens_iv: enc.i,
      tokens_tag: enc.t,
      oauth_state: null,
      status: 'connected',
      meta,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)

  return { provider: row.provider, channel: meta.channel || null }
}

// Returns a valid access token, refreshing if expired. Null if not connected.
export async function getAccessToken(userId, provider) {
  const row = await getRow(userId, provider)
  if (!row || row.status !== 'connected' || !row.tokens_ciphertext) return null

  const tokens = JSON.parse(decField(row.tokens_ciphertext, row.tokens_iv, row.tokens_tag))
  if (Date.now() < tokens.expiry) return tokens.access_token

  // Expired — refresh.
  const refreshed = await refreshAccessToken({
    clientId: row.client_id,
    clientSecret: secretFor(row),
    refreshToken: tokens.refresh_token,
  })
  const stored = {
    access_token: refreshed.access_token,
    refresh_token: tokens.refresh_token,
    expiry: Date.now() + (refreshed.expires_in || 3600) * 1000 - 60000,
  }
  const enc = encField(JSON.stringify(stored))
  await supabaseAdmin
    .from('native_connections')
    .update({ tokens_ciphertext: enc.c, tokens_iv: enc.i, tokens_tag: enc.t, updated_at: new Date().toISOString() })
    .eq('id', row.id)
  return refreshed.access_token
}

export async function disconnectNative(userId, provider) {
  const { error } = await supabaseAdmin
    .from('native_connections')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider)
  if (error) throw error
}

export async function getConnectedProviders(userId) {
  const { data, error } = await supabaseAdmin
    .from('native_connections')
    .select('provider, status')
    .eq('user_id', userId)
    .eq('status', 'connected')
  if (error) throw error
  return (data || []).map((r) => r.provider)
}
