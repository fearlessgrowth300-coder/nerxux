import { api, apiError } from './api'

// Uploads a file (image / PDF / video). Returns the attachment descriptor:
//  - image/pdf: { kind, filename, mimeType, base64 }
//  - video:     { kind:'video', filename, source, analysis }
// A phone photo is several megabytes, and an attachment rides to the model as
// base64 — which is ~33% larger again. That overflowed the request body and
// came back as the raw "request entity too large", so images from a phone
// simply never worked. Shrink first: no vision model needs 12 megapixels, and
// a smaller image is faster to send and cheaper to read.
const MAX_EDGE = 1600
const SHRINK_ABOVE_BYTES = 900_000

async function shrinkImage(file) {
  if (!file.type?.startsWith('image/') || file.size <= SHRINK_ABOVE_BYTES) return file
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    // Already small in pixels but heavy in bytes — re-encoding still helps.
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85))
    if (!blob || blob.size >= file.size) return file // no gain — keep the original
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file // a browser without createImageBitmap still gets to try
  }
}

export async function uploadFile(file) {
  try {
    const form = new FormData()
    form.append('file', await shrinkImage(file))
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
