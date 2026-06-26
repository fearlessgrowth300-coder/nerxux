// Facebook / Meta OAuth + Graph API helpers. Mirrors the google.js interface so
// the native-connector framework (nativeStore.js) can drive it generically.
//
// Flow: buildAuthUrl -> user logs in at facebook.com -> callback with ?code ->
// exchangeCode (short-lived -> long-lived ~60-day token). Facebook has no
// refresh token; when the long-lived token expires the user reconnects.
const GRAPH = 'https://graph.facebook.com/v19.0'
const DIALOG = 'https://www.facebook.com/v19.0/dialog/oauth'

export const FACEBOOK_SCOPES = ['public_profile', 'email']

export function buildAuthUrl({ clientId, redirectUri, state, scopes = FACEBOOK_SCOPES }) {
  const u = new URL(DIALOG)
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('state', state)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', scopes.join(','))
  return u.toString()
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  // 1) code -> short-lived token
  const u1 = new URL(`${GRAPH}/oauth/access_token`)
  u1.searchParams.set('client_id', clientId)
  u1.searchParams.set('client_secret', clientSecret)
  u1.searchParams.set('redirect_uri', redirectUri)
  u1.searchParams.set('code', code)
  const r1 = await fetch(u1)
  const d1 = await r1.json()
  if (!r1.ok || !d1.access_token) {
    throw new Error(`Facebook token exchange failed: ${d1.error?.message || r1.status}`)
  }
  // 2) short-lived -> long-lived (~60 days)
  let token = d1.access_token
  let expires = d1.expires_in || 3600
  try {
    const u2 = new URL(`${GRAPH}/oauth/access_token`)
    u2.searchParams.set('grant_type', 'fb_exchange_token')
    u2.searchParams.set('client_id', clientId)
    u2.searchParams.set('client_secret', clientSecret)
    u2.searchParams.set('fb_exchange_token', d1.access_token)
    const r2 = await fetch(u2)
    const d2 = await r2.json()
    if (r2.ok && d2.access_token) {
      token = d2.access_token
      expires = d2.expires_in || 60 * 24 * 3600
    }
  } catch { /* keep short-lived if long-lived exchange fails */ }
  return { access_token: token, refresh_token: null, expires_in: expires }
}

export async function getProfile(accessToken) {
  const u = new URL(`${GRAPH}/me`)
  u.searchParams.set('fields', 'id,name,email')
  u.searchParams.set('access_token', accessToken)
  const r = await fetch(u)
  const d = await r.json()
  if (!r.ok) throw new Error(`Facebook profile fetch failed: ${d.error?.message || r.status}`)
  return d
}

// Pages the account manages (needs the pages_show_list permission + app review).
export async function getPages(accessToken) {
  const u = new URL(`${GRAPH}/me/accounts`)
  u.searchParams.set('fields', 'name,category,id')
  u.searchParams.set('access_token', accessToken)
  const r = await fetch(u)
  const d = await r.json()
  if (!r.ok) throw new Error(`Facebook pages fetch failed: ${d.error?.message || r.status}`)
  return d.data || []
}
