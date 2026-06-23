// Extract plain text from a PDF in the browser (no server / Python needed).
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const MAX_CHARS = 200_000 // keep notes a sane size

export async function extractPdfText(file) {
  const buf = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise
  const parts = []
  let total = 0
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const pageText = content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim()
    if (pageText) {
      parts.push(pageText)
      total += pageText.length
    }
    if (total > MAX_CHARS) {
      parts.push('\n…(truncated — PDF longer than the note limit)')
      break
    }
  }
  return parts.join('\n\n')
}
