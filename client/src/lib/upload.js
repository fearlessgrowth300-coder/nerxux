import { api, apiError } from './api'

// Uploads a video file (multipart) for Gemini vision analysis.
// Returns { filename, source, analysis }. `source` is 'gemini' | 'stub' | 'error'.
export async function uploadVideo(file) {
  try {
    const form = new FormData()
    form.append('video', file)
    const { data } = await api.post('/api/upload', form)
    return data
  } catch (err) {
    throw apiError(err, 'Video upload failed')
  }
}

// Flattens a structured analysis into a readable context block that gets
// injected into the next model's prompt.
export function analysisToContext(analysis) {
  if (!analysis) return ''
  const lines = [
    'VIDEO ANALYSIS (auto-generated from an uploaded video):',
    `- Scene: ${analysis.scene || 'n/a'}`,
    `- Objects: ${(analysis.objects || []).join(', ') || 'n/a'}`,
    `- Tone: ${analysis.tone || 'n/a'}`,
    `- Duration: ${analysis.duration || 'n/a'}`,
  ]
  if (analysis.keyMoments?.length) {
    lines.push('- Key moments:')
    for (const m of analysis.keyMoments) {
      lines.push(`  - ${m.time || '?'}: ${m.description || ''}`)
    }
  }
  return lines.join('\n')
}
