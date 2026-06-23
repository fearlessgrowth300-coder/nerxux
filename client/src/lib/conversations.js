import { supabase } from './supabase'

// Persistent conversation history — the app's "second brain". RLS scopes every
// query to the current user, so reads don't filter by user_id (but inserts set
// it). Each message stores its full object in `data` so attachments / media /
// routing cards survive a reload.

export async function listConversations() {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, title, created_at, updated_at')
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function createConversation(title = 'New chat') {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { data, error } = await supabase
    .from('conversations')
    .insert({ user_id: user.id, title: title.slice(0, 80) || 'New chat' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function renameConversation(id, title) {
  const { error } = await supabase
    .from('conversations')
    .update({ title: title.slice(0, 80), updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function touchConversation(id) {
  await supabase.from('conversations')
    .update({ updated_at: new Date().toISOString() }).eq('id', id)
}

export async function deleteConversation(id) {
  const { error } = await supabase.from('conversations').delete().eq('id', id)
  if (error) throw error
}

export async function listMessages(conversationId) {
  const { data, error } = await supabase
    .from('conversation_messages')
    .select('data')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
  if (error) throw error
  // Each row's `data` is the original message object.
  return (data ?? []).map((r) => r.data).filter(Boolean)
}

// Persist a batch of message objects to a conversation. Transient cards
// (approval prompts, typing) are not saved.
export async function saveMessages(conversationId, msgs) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  const rows = (msgs || [])
    .filter((m) => m && m.role && m.role !== 'approval')
    .map((m) => ({
      conversation_id: conversationId,
      user_id: user.id,
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
      model: m.model || null,
      data: m,
    }))
  if (!rows.length) return
  const { error } = await supabase.from('conversation_messages').insert(rows)
  if (error) throw error
  await touchConversation(conversationId)
}
