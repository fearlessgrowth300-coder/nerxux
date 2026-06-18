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

export async function createSkill({ name, description, content, enabled = true }) {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data, error } = await supabase
    .from('skills')
    .insert({ user_id: user.id, name, description, content, enabled })
    .select()
    .single()
  if (error) throw error
  return data
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
