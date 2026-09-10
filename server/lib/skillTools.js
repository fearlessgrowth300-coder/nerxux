import { supabaseAdmin } from './supabase.js'

// Skills are INSTRUCTIONS, not training. A skill is a document that gets put in
// front of the model when it is relevant — nothing is learned, and removing a
// skill removes the behaviour immediately.
//
// The old approach pasted every enabled skill, in full, into every single
// message. That is fine for two skills and impossible for thirty: a library of
// real skills runs to hundreds of KB, which would be re-sent on every turn, in
// every chat, whether or not any of it applied.
//
// So the system prompt carries only an INDEX — one line per skill, name and
// description — and the model calls load_skill when a line looks relevant. That
// is how skills are meant to work: the description is the trigger, the body is
// fetched on demand.

const MAX_SKILL_CHARS = 60_000

export const LOAD_SKILL_TOOL = {
  name: 'load_skill',
  description:
    'Read the full instructions for one of the available skills, by name. Call this as soon as ' +
    'a skill in the "Skills available" list looks relevant to the request, BEFORE starting the ' +
    'work, and then follow what it says.',
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The skill name, exactly as listed.' } },
    required: ['name'],
  },
}

export const READ_SKILL_FILE_TOOL = {
  name: 'read_skill_file',
  description:
    'Read one of the files bundled with a skill (references, scripts, templates). ' +
    'The file names are listed at the end of the skill instructions.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name.' },
      path: { type: 'string', description: 'The bundled file path, exactly as listed.' },
    },
    required: ['name', 'path'],
  },
}

export const SKILL_TOOL_NAMES = new Set([LOAD_SKILL_TOOL.name, READ_SKILL_FILE_TOOL.name])

async function fetchSkills(userId) {
  // `resources` is a newer column; tolerate a database that predates it rather
  // than failing every chat.
  for (const columns of ['name, description, content, resources', 'name, description, content']) {
    const { data, error } = await supabaseAdmin
      .from('skills')
      .select(columns)
      .eq('user_id', userId)
      .eq('enabled', true)
      .order('name', { ascending: true })
    if (!error) return data || []
    if (!/resources/.test(error.message || '')) throw error
  }
  return []
}

function findSkill(skills, wanted = '') {
  const want = String(wanted).trim().toLowerCase()
  return (
    skills.find((s) => (s.name || '').toLowerCase() === want) ||
    // Models paraphrase ("the pdf skill"), so fall back to a contains match
    // rather than answering "not found" for a skill that plainly exists.
    skills.find((s) => (s.name || '').toLowerCase().includes(want)) ||
    skills.find((s) => want.includes((s.name || '').toLowerCase()))
  )
}

/**
 * Index + tools for a user's enabled skills.
 * @returns {{ index: string, tools: Array, has: (name:string)=>boolean, run: (name:string, args:object)=>Promise<string> }}
 */
export async function buildSkillToolset(userId) {
  let skills = []
  try {
    skills = await fetchSkills(userId)
  } catch {
    skills = []
  }

  if (!skills.length) {
    return { index: '', tools: [], has: () => false, run: async () => 'No skills are available.' }
  }

  const lines = skills.map((s) => {
    const desc = (s.description || '').trim() || '(no description)'
    return `- ${s.name}: ${desc}`
  })
  const index =
    '# Skills available\n' +
    "These are the user's saved skills. When one is relevant to the request, call " +
    'load_skill with its name to read the full instructions, then follow them.\n' +
    lines.join('\n')

  const hasResources = skills.some((s) => s.resources && Object.keys(s.resources).length)

  return {
    index,
    tools: hasResources ? [LOAD_SKILL_TOOL, READ_SKILL_FILE_TOOL] : [LOAD_SKILL_TOOL],
    has: (name) => SKILL_TOOL_NAMES.has(name),
    async run(name, args = {}) {
      const skill = findSkill(skills, args.name)
      if (!skill) {
        return `No skill named "${args.name}". Available: ${skills.map((s) => s.name).join(', ')}`
      }
      if (name === READ_SKILL_FILE_TOOL.name) {
        const files = skill.resources || {}
        const path = String(args.path || '')
        const body = files[path] ?? files[path.replace(/^\.?\//, '')]
        if (body == null) {
          const available = Object.keys(files)
          return available.length
            ? `No file "${path}" in skill "${skill.name}". Bundled files: ${available.join(', ')}`
            : `Skill "${skill.name}" has no bundled files.`
        }
        return body.slice(0, MAX_SKILL_CHARS)
      }
      const body = (skill.content || '').slice(0, MAX_SKILL_CHARS)
      const files = Object.keys(skill.resources || {})
      return (
        `# Skill: ${skill.name}\n${body}` +
        (files.length ? `\n\n---\nBundled files (read with read_skill_file): ${files.join(', ')}` : '')
      )
    },
  }
}
