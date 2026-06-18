import { getInstructions } from './instructions'
import { listSkills } from './skills'

// Builds the full system prompt sent to models: the user's global instructions
// followed by every ENABLED skill's content. This is what makes Instructions
// (Step 4) and Skills (Step 5) actually take effect in chat (Steps 7–11).
export async function buildSystemPrompt() {
  const [instructions, skills] = await Promise.all([
    getInstructions(),
    listSkills(),
  ])

  const parts = []
  if (instructions.trim()) parts.push(instructions.trim())

  const enabled = skills.filter((s) => s.enabled && s.content.trim())
  for (const s of enabled) {
    parts.push(`## Skill: ${s.name}\n${s.content.trim()}`)
  }

  return parts.join('\n\n')
}
