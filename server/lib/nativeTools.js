import { getAccessToken, getConnectedProviders } from './nativeStore.js'
import { getMyChannel, listMyVideos, getVideoStats, searchVideos } from './google.js'

// Extracts a video id from an id or a YouTube URL.
function extractVideoId(s = '') {
  const m = String(s).match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/)
  return m ? m[1] : String(s).trim()
}

const YOUTUBE_TOOLS = [
  {
    name: 'youtube_my_channel',
    description: 'Get the connected YouTube channel: title, description, and statistics (subscribers, total views, video count).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'youtube_my_videos',
    description: "List the connected channel's most recent uploaded videos with views, likes and comment counts.",
    input_schema: { type: 'object', properties: { max: { type: 'integer', description: 'How many videos (1-50, default 10)' } } },
  },
  {
    name: 'youtube_video_stats',
    description: 'Get statistics for a specific YouTube video by id or URL.',
    input_schema: { type: 'object', properties: { videoId: { type: 'string', description: 'Video id or URL' } }, required: ['videoId'] },
  },
  {
    name: 'youtube_search',
    description: 'Search public YouTube videos by keyword.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer' } }, required: ['query'] },
  },
]

async function runYoutube(userId, name, input) {
  const token = await getAccessToken(userId, 'youtube')
  if (!token) return 'YouTube is not connected. Connect it under Connections first.'
  switch (name) {
    case 'youtube_my_channel':
      return JSON.stringify(await getMyChannel(token))
    case 'youtube_my_videos':
      return JSON.stringify(await listMyVideos(token, { max: input?.max || 10 }))
    case 'youtube_video_stats':
      return JSON.stringify(await getVideoStats(token, extractVideoId(input?.videoId)))
    case 'youtube_search':
      return JSON.stringify(await searchVideos(token, { query: input?.query, max: input?.max || 10 }))
    default:
      return `Unknown tool: ${name}`
  }
}

// Registry of native providers.
export const NATIVE_PROVIDERS = {
  youtube: { label: 'YouTube', tools: YOUTUBE_TOOLS, run: runYoutube },
}

// Builds the native toolset for a user's connected providers:
// { tools: [...anthropic tool defs], run(name, input) }
export async function buildNativeToolset(userId) {
  const providers = await getConnectedProviders(userId)
  const tools = []
  const routeMap = new Map() // toolName -> provider
  for (const p of providers) {
    const def = NATIVE_PROVIDERS[p]
    if (!def) continue
    for (const t of def.tools) {
      tools.push(t)
      routeMap.set(t.name, p)
    }
  }
  const run = async (name, input) => {
    const provider = routeMap.get(name)
    if (!provider) return null // not a native tool
    return NATIVE_PROVIDERS[provider].run(userId, name, input)
  }
  return { tools, has: (name) => routeMap.has(name), run }
}
