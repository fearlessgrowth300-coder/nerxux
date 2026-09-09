// Attachments arrive from the client as { kind, filename, mimeType, base64,
// text? }. Claude and Gemini read PDFs natively from the base64; everything
// else (GPT-4o, Groq's open models, the local Ollama models) can't, so the
// client also extracts the PDF's text up front and those adapters get it as
// plain context instead of a "can't read this" apology.
const MAX_CHARS_PER_DOC = 60_000

export function documentContext(attachments = []) {
  const blocks = []
  for (const a of attachments) {
    if (a?.kind !== 'pdf') continue
    const text = String(a.text || '').trim()
    const name = a.filename || 'document.pdf'
    if (!text) {
      blocks.push(`[Attached PDF "${name}" — no readable text could be extracted (scanned image?).]`)
      continue
    }
    const body = text.length > MAX_CHARS_PER_DOC ? text.slice(0, MAX_CHARS_PER_DOC) + '\n…(truncated)' : text
    blocks.push(`[Attached PDF "${name}" — full text follows]\n${body}\n[End of "${name}"]`)
  }
  return blocks.join('\n\n')
}

// Prompt + any document text, ready to hand to a text-only model.
export function withDocuments(prompt, attachments) {
  const docs = documentContext(attachments)
  return docs ? `${docs}\n\n${prompt}` : prompt
}

export function imageAttachments(attachments = []) {
  return attachments.filter((a) => a?.kind === 'image' && a.base64)
}
