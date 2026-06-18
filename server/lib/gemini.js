import { GoogleGenerativeAI } from '@google/generative-ai'
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server'

const ANALYSIS_PROMPT = `You are a video analyst. Watch the video and return ONLY a JSON object (no prose, no code fences) with exactly these keys:
{
  "scene": "1-2 sentence description of the overall scene/setting",
  "objects": ["notable objects, people, or subjects visible"],
  "tone": "the mood/tone/style (e.g. energetic, calm, cinematic)",
  "duration": "approximate duration like '0:12'",
  "keyMoments": [{"time": "0:03", "description": "what happens"}]
}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Pulls the first JSON object out of a model response (handles stray prose or
// accidental code fences).
function extractJson(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON found in model response')
  return JSON.parse(cleaned.slice(start, end + 1))
}

// Analyzes a local video file with Gemini 1.5 Pro vision.
// Returns the structured analysis object. Throws on failure so the caller can
// decide whether to fall back to a stub.
export async function analyzeVideo({ apiKey, filePath, mimeType, displayName }) {
  const fileManager = new GoogleAIFileManager(apiKey)

  // 1) Upload via the File API (required for video input).
  const uploaded = await fileManager.uploadFile(filePath, { mimeType, displayName })
  let file = uploaded.file

  // 2) Wait for Google to finish processing the video.
  const deadline = Date.now() + 120000 // 2 min cap
  while (file.state === FileState.PROCESSING) {
    if (Date.now() > deadline) throw new Error('Gemini video processing timed out')
    await sleep(2500)
    file = await fileManager.getFile(file.name)
  }
  if (file.state === FileState.FAILED) {
    throw new Error('Gemini failed to process the video')
  }

  // 3) Ask Gemini 1.5 Pro to analyze it.
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' })
  const result = await model.generateContent([
    { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
    { text: ANALYSIS_PROMPT },
  ])
  const text = result.response.text()

  // 4) Best-effort cleanup of the uploaded file (don't fail the request on this).
  fileManager.deleteFile(file.name).catch(() => {})

  return extractJson(text)
}

// A clearly-marked placeholder used when no Gemini key is connected, so the
// upload → inject flow is fully testable without credentials.
export function stubAnalysis({ filename, sizeBytes }) {
  return {
    scene: `Stub analysis for "${filename}" — connect a Gemini key in Connections for real vision analysis.`,
    objects: ['(analysis unavailable without Gemini key)'],
    tone: 'unknown',
    duration: 'unknown',
    keyMoments: [],
    _stub: true,
    _sizeBytes: sizeBytes,
  }
}
