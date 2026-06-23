import { getInstructions } from './instructions'
import { listSkills } from './skills'
import { listContextNotes } from './notes'

const NOTES_BUDGET = 8000 // cap injected notes so we don't blow the context

// Builds the full system prompt sent to models: the user's global instructions,
// every ENABLED skill, and any notes flagged as AI knowledge (the second brain).
export async function buildSystemPrompt() {
  const [instructions, skills, notes] = await Promise.all([
    getInstructions(),
    listSkills(),
    listContextNotes().catch(() => []), // notes table optional / may not exist yet
  ])

  const parts = []
  if (instructions.trim()) parts.push(instructions.trim())

  const enabled = skills.filter((s) => s.enabled && s.content.trim())
  for (const s of enabled) {
    parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }

  // Inject knowledge notes, newest first, up to the budget.
  const useful = (notes || []).filter((n) => (n.content || '').trim())
  if (useful.length) {
    const chunks = []
    let used = 0
    for (const n of useful) {
      const block = `### ${n.title}\n${n.content.trim()}`
      if (used + block.length > NOTES_BUDGET) break
      chunks.push(block)
      used += block.length
    }
    if (chunks.length) {
      parts.push(`# Knowledge base (the user's notes — use these as background knowledge)\n${chunks.join('\n\n')}`)
    }
  }

  return parts.join('\n\n')
}
