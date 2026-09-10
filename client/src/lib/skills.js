import { supabase } from './supabase'

// Data access for user skills. RLS scopes every query to the current user, so
// we never filter by user_id on reads — but we must set it on insert.

export async function listSkills() {
  const { data, error } = await supabase
    .from('skills')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

export async function createSkill({ name, description, content, enabled = true, resources = null }) {
  const { data: { session } } = await supabase.auth.getSession()
  const userId = session?.user?.id || (await supabase.auth.getUser()).data?.user?.id
  if (!userId) throw new Error('Not signed in — sign in again to save skills.')

  const row = { user_id: userId, name, description, content, enabled }
  if (resources && Object.keys(resources).length) row.resources = resources

  // Re-importing the same zip must UPDATE each skill, not add a second copy.
  // Without this an accidental double import doubled the index the model reads
  // on every message.
  const { data: existing } = await supabase
    .from('skills').select('id').eq('user_id', userId).eq('name', name).maybeSingle()
  if (existing?.id) {
    const upd = await supabase.from('skills')
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq('id', existing.id).select().single()
    if (upd.error) throw upd.error
    return { ...upd.data, replaced: true }
  }

  const { data, error } = await supabase.from('skills').insert(row).select().single()
  if (error) {
    // The bundled-files column is newer than some databases. Save the skill
    // itself rather than losing the whole import over its extras.
    if (row.resources && /resources/.test(error.message || '')) {
      delete row.resources
      const retry = await supabase.from('skills').insert(row).select().single()
      if (retry.error) throw retry.error
      return { ...retry.data, resourcesSkipped: true }
    }
    throw error
  }
  return data
}

// Imports every skill folder in a .zip. Returns what happened per skill so the
// UI can report it honestly instead of a silent partial success.
export async function importSkillsFromZip(file) {
  const { readSkillsFromZip } = await import('./skillArchive')
  const found = await readSkillsFromZip(file)
  const results = []
  for (const skill of found) {
    try {
      const saved = await createSkill(skill)
      results.push({
        name: skill.name,
        ok: true,
        files: Object.keys(skill.resources || {}).length,
        resourcesSkipped: Boolean(saved.resourcesSkipped),
        replaced: Boolean(saved.replaced),
        skipped: skill.skipped,
      })
    } catch (e) {
      results.push({ name: skill.name, ok: false, error: e.message })
    }
  }
  return results
}

export async function updateSkill(id, patch) {
  const { data, error } = await supabase
    .from('skills')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteSkill(id) {
  const { error } = await supabase.from('skills').delete().eq('id', id)
  if (error) throw error
}
