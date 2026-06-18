// Video generation via the Higgsfield API.
// { prompt, apiKey, model? } -> normalized response with a video URL.
//
// Higgsfield uses an async create-then-poll flow: POST a generation request,
// receive a job id, poll until the job completes, then return the asset URL.
// The exact base URL / paths depend on your Higgsfield plan — override them via
// HIGGSFIELD_API_BASE if needed. This adapter implements the common shape and
// fails loudly with the provider's error so it's easy to adjust.

const API_BASE = process.env.HIGGSFIELD_API_BASE || 'https://platform.higgsfield.ai/v1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function hf(path, apiKey, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text }
  }
  if (!res.ok) {
    throw new Error(`Higgsfield ${res.status}: ${(text || '').slice(0, 160)}`)
  }
  return body
}

export async function run({ prompt, apiKey, model }) {
  if (!apiKey) throw new Error('Higgsfield API key is not connected')
  const text = (prompt || '').trim()
  if (!text) throw new Error('Nothing to generate (empty prompt)')

  // 1) Create the generation job.
  const created = await hf('/video/generations', apiKey, {
    method: 'POST',
    body: JSON.stringify({ prompt: text, model: model || 'higgsfield-1' }),
  })
  const jobId = created.id || created.job_id || created.generation_id
  if (!jobId) {
    return {
      ok: true,
      provider: 'higgsfield',
      type: 'video',
      content: 'Higgsfield generation submitted.',
      media: created.url ? { mimeType: 'video/mp4', url: created.url } : null,
      raw: created,
    }
  }

  // 2) Poll until the job finishes (cap at ~3 minutes).
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    await sleep(4000)
    const status = await hf(`/video/generations/${jobId}`, apiKey)
    const state = status.status || status.state
    if (state === 'completed' || state === 'succeeded' || status.url) {
      const url =
        status.url ||
        status.result?.url ||
        status.output?.[0]?.url ||
        null
      return {
        ok: true,
        provider: 'higgsfield',
        type: 'video',
        content: url ? 'Video generated.' : 'Generation completed.',
        media: url ? { mimeType: 'video/mp4', url } : null,
        model: model || 'higgsfield-1',
        raw: status,
      }
    }
    if (state === 'failed' || state === 'error') {
      throw new Error(`Higgsfield generation failed: ${status.error || 'unknown error'}`)
    }
  }
  throw new Error('Higgsfield generation timed out')
}
