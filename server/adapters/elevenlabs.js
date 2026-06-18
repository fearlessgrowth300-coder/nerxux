// Text-to-speech via the ElevenLabs API.
// { prompt, apiKey, voiceId?, model? } -> normalized response with base64 audio.
// `prompt` is the text to speak. The audio is returned inline (base64 mp3) so
// the client can play it without a second round-trip.

const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM' // "Rachel" — a default ElevenLabs voice

export async function run({ prompt, apiKey, voiceId, model }) {
  if (!apiKey) throw new Error('ElevenLabs API key is not connected')
  const text = (prompt || '').trim()
  if (!text) throw new Error('Nothing to synthesize (empty text)')

  const voice = voiceId || DEFAULT_VOICE
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: model || 'eleven_multilingual_v2',
      }),
    }
  )

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 160)}`)
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  return {
    ok: true,
    provider: 'elevenlabs',
    type: 'audio',
    content: `Generated ${(buffer.length / 1024).toFixed(0)} KB of speech audio.`,
    media: {
      mimeType: 'audio/mpeg',
      base64: buffer.toString('base64'),
    },
    model: model || 'eleven_multilingual_v2',
  }
}
