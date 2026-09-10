import JSZip from 'jszip'

// Reads Anthropic-style Skill folders out of a .zip.
//
// A skill is a folder containing SKILL.md, whose YAML frontmatter carries the
// name and description, plus optional bundled files (references, scripts).
// A zip may hold one skill or many, and may or may not have a wrapping folder,
// so skills are located by finding every SKILL.md rather than by assuming a
// layout.

const MAX_RESOURCE_BYTES = 40_000 // per file — keep a skill row sane
const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|toml|csv|py|js|ts|sh|bash|sql|html|css)$/i

// Minimal YAML frontmatter reader: the subset Skills actually use (flat
// key: value pairs, optionally quoted). Not a general YAML parser, and
// deliberately so — a wrong-but-confident parse is worse than a missing field.
export function parseFrontmatter(text = '') {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text.trim() }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    meta[m[1].toLowerCase()] = value
  }
  return { meta, body: text.slice(match[0].length).trim() }
}

function titleFromPath(path) {
  const parts = path.split('/').filter(Boolean)
  // .../<skill-name>/SKILL.md
  return parts.length >= 2 ? parts[parts.length - 2] : 'skill'
}

/**
 * @param {File|Blob} file  a .zip
 * @returns {Promise<Array<{name,description,content,resources,skipped}>>}
 */
export async function readSkillsFromZip(file) {
  const zip = await JSZip.loadAsync(file)

  const skillFiles = Object.keys(zip.files).filter(
    (p) => !zip.files[p].dir && /(^|\/)SKILL\.md$/i.test(p)
  )
  if (!skillFiles.length) {
    throw new Error('No SKILL.md found in that zip. A skill folder must contain a SKILL.md file.')
  }

  const skills = []
  for (const path of skillFiles) {
    const raw = await zip.files[path].async('string')
    const { meta, body } = parseFrontmatter(raw)
    const dir = path.replace(/SKILL\.md$/i, '')

    // Everything else shipped alongside it.
    const resources = {}
    const skipped = []
    for (const other of Object.keys(zip.files)) {
      if (other === path || zip.files[other].dir) continue
      if (!other.startsWith(dir)) continue
      const rel = other.slice(dir.length)
      if (!rel || rel.startsWith('__MACOSX') || rel.endsWith('.DS_Store')) continue
      if (!TEXT_EXT.test(rel)) { skipped.push(rel); continue }
      const content = await zip.files[other].async('string')
      if (content.length > MAX_RESOURCE_BYTES) { skipped.push(`${rel} (too large)`); continue }
      resources[rel] = content
    }

    skills.push({
      name: (meta.name || titleFromPath(path)).trim(),
      description: (meta.description || '').trim(),
      content: body,
      resources,
      skipped,
      enabled: true,
    })
  }
  return skills
}
