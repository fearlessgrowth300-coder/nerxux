// Google OAuth2 (authorization-code + refresh) and YouTube Data API v3 helpers.
// Used by the YouTube native connector. The user supplies their own Google
// Cloud OAuth client (client_id + secret).

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const YT = 'https://www.googleapis.com/youtube/v3'

// Read-only YouTube access (channel, videos, search, comments).
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly']

export function buildAuthUrl({ clientId, redirectUri, state, scopes = YOUTUBE_SCOPES }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline', // request a refresh token
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${AUTH_URL}?${p.toString()}`
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Google token exchange failed: ${data.error_description || data.error || res.status}`)
  return data // { access_token, refresh_token, expires_in, ... }
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Google token refresh failed: ${data.error_description || data.error || res.status}`)
  return data // { access_token, expires_in, ... } (no new refresh_token)
}

async function ytGet(accessToken, path, params) {
  const url = `${YT}${path}?${new URLSearchParams(params).toString()}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  const data = await res.json()
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${data.error?.message || 'request failed'}`)
  return data
}

// ---- YouTube Data API actions (read) ----

export async function getMyChannel(accessToken) {
  const data = await ytGet(accessToken, '/channels', {
    part: 'snippet,statistics,contentDetails',
    mine: 'true',
  })
  const ch = data.items?.[0]
  if (!ch) return { connected: true, channel: null }
  return {
    id: ch.id,
    title: ch.snippet?.title,
    description: ch.snippet?.description,
    customUrl: ch.snippet?.customUrl,
    uploadsPlaylist: ch.contentDetails?.relatedPlaylists?.uploads,
    stats: ch.statistics, // subscriberCount, viewCount, videoCount
  }
}

export async function listMyVideos(accessToken, { max = 10 } = {}) {
  const ch = await getMyChannel(accessToken)
  if (!ch?.uploadsPlaylist) return []
  const pl = await ytGet(accessToken, '/playlistItems', {
    part: 'snippet,contentDetails',
    playlistId: ch.uploadsPlaylist,
    maxResults: String(Math.min(max, 50)),
  })
  const ids = (pl.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean)
  if (!ids.length) return []
  const vids = await ytGet(accessToken, '/videos', {
    part: 'snippet,statistics',
    id: ids.join(','),
  })
  return (vids.items || []).map((v) => ({
    id: v.id,
    title: v.snippet?.title,
    publishedAt: v.snippet?.publishedAt,
    views: v.statistics?.viewCount,
    likes: v.statistics?.likeCount,
    comments: v.statistics?.commentCount,
    url: `https://youtu.be/${v.id}`,
  }))
}

export async function getVideoStats(accessToken, videoId) {
  const data = await ytGet(accessToken, '/videos', { part: 'snippet,statistics', id: videoId })
  const v = data.items?.[0]
  if (!v) return null
  return {
    id: v.id,
    title: v.snippet?.title,
    channel: v.snippet?.channelTitle,
    publishedAt: v.snippet?.publishedAt,
    stats: v.statistics,
    url: `https://youtu.be/${v.id}`,
  }
}

export async function searchVideos(accessToken, { query, max = 10 }) {
  const data = await ytGet(accessToken, '/search', {
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: String(Math.min(max, 25)),
  })
  return (data.items || []).map((i) => ({
    id: i.id?.videoId,
    title: i.snippet?.title,
    channel: i.snippet?.channelTitle,
    publishedAt: i.snippet?.publishedAt,
    url: `https://youtu.be/${i.id?.videoId}`,
  }))
}
