import { api, apiError } from './api'

// Uploads a file (image / PDF / video). Returns the attachment descriptor:
//  - image/pdf: { kind, filename, mimeType, base64 }
//  - video:     { kind:'video', filename, source, analysis }
export async function uploadFile(file) {
  try {
    const form = new FormData()
    form.append('file', file)
    const { data } = await api.post('/api/upload', form)
    return data
  } catch (err) {
    throw apiError(err, 'Upload failed')
  }
}

// Flattens a video analysis into a readable context block for the next message.
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
    for (const m of analysis.keyMoments) lines.push(`  - ${m.time || '?'}: ${m.description || ''}`)
  }
  return lines.join('\n')
}
