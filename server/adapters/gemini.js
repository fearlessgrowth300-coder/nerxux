import { GoogleGenerativeAI } from '@google/generative-ai'

function composeSystem(systemPrompt = '', skills = []) {
  const parts = []
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  for (const s of skills || []) {
    if (s?.content?.trim()) parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }
  return parts.join('\n\n')
}

// Text + vision generation via Google Generative AI.
// { prompt, systemPrompt, skills, apiKey, model, media } -> normalized response.
// `media` (optional) is { mimeType, base64 } for inline image/video input.
export async function run({ prompt, systemPrompt, skills, apiKey, model, media }) {
  if (!apiKey) throw new Error('Gemini API key is not connected')

  const genAI = new GoogleGenerativeAI(apiKey)
  const system = composeSystem(systemPrompt, skills)

  const generativeModel = genAI.getGenerativeModel({
    model: model || 'gemini-1.5-pro',
    ...(system ? { systemInstruction: system } : {}),
  })

  // Build content parts: prompt text + optional inline media / attachments.
  const parts = [{ text: prompt }]
  if (media?.base64 && media?.mimeType) {
    parts.push({ inlineData: { mimeType: media.mimeType, data: media.base64 } })
  }
  for (const a of arguments[0]?.attachments || []) {
    if (a.base64 && a.mimeType && (a.kind === 'image' || a.kind === 'pdf')) {
      parts.push({ inlineData: { mimeType: a.mimeType, data: a.base64 } })
    }
  }

  const result = await generativeModel.generateContent(parts)

  return {
    ok: true,
    provider: 'gemini',
    type: 'text',
    content: result.response.text(),
    model: model || 'gemini-1.5-pro',
    usage: result.response.usageMetadata,
  }
}
