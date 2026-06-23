import { supabase } from './supabase'

// Obsidian-style notes: markdown + [[wiki links]]. RLS scopes to the user.

const LINK_RE = /\[\[([^\]]+)\]\]/g

// Titles referenced by [[...]] inside a note's content.
export function outgoingLinks(content = '') {
  const out = new Set()
  let m
  while ((m = LINK_RE.exec(content))) out.add(m[1].trim())
  return [...out]
}

// Notes whose content links to `title` (case-insensitive).
export function backlinks(notes, title) {
  const t = (title || '').toLowerCase()
  return (notes || []).filter((n) =>
    outgoingLinks(n.content).some((l) => l.toLowerCase() === t))
}

export async function listNotes() {
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function createNote({ title = 'Untitled', content = '' } = {}) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { data, error } = await supabase
    .from('notes')
    .insert({ user_id: user.id, title: title.slice(0, 120) || 'Untitled', content })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateNote(id, patch) {
  const { data, error } = await supabase
    .from('notes')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteNote(id) {
  const { error } = await supabase.from('notes').delete().eq('id', id)
  if (error) throw error
}

// Notes the user flagged as AI knowledge (used by buildSystemPrompt).
export async function listContextNotes() {
  const { data, error } = await supabase
    .from('notes')
    .select('title, content')
    .eq('in_context', true)
  if (error) throw error
  return data ?? []
}
