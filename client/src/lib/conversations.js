import { supabase } from './supabase'

// Persistent conversation history — the app's "second brain". RLS scopes every
// query to the current user, so reads don't filter by user_id (but inserts set
// it). Each message stores its full object in `data` so attachments / media /
// routing cards survive a reload.

// supabase.auth.getUser() is a NETWORK call to /auth/v1/user, so saving a
// conversation depended on an extra round trip that fails on a flaky phone
// connection — and the UI reported that as "cloud history is unavailable" even
// though the database was perfectly reachable. getSession() reads the persisted
// session locally and only goes to the network when the token needs refreshing.
async function currentUserId() {
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.user?.id) return session.user.id
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error) throw new Error(`not signed in: ${error.message}`)
  if (!user) throw new Error('not signed in — sign out and back in to sync history')
  return user.id
}

export async function listConversations() {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, title, created_at, updated_at')
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export async function createConversation(title = 'New chat') {
  const userId = await currentUserId()
  const { data, error } = await supabase
    .from('conversations')
    .insert({ user_id: userId, title: title.slice(0, 80) || 'New chat' })
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
  const { error } = await supabase.from('conversations')
    .update({ updated_at: new Date().toISOString() }).eq('id', id)
  if (error) throw error
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

// Postgres text/jsonb cannot hold U+0000, and tool output sometimes contains it
// (a binary file printed to the terminal). One such byte failed the whole save.
function withoutNul(value) {
  if (typeof value === 'string') return value.split('\u0000').join('')
  if (Array.isArray(value)) return value.map(withoutNul)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutNul(v)]))
  }
  return value
}

// Persist a batch of message objects to a conversation. Transient cards
// (approval prompts, typing) are not saved.
export async function saveMessages(conversationId, msgs) {
  msgs = withoutNul(msgs)
  const userId = await currentUserId()
  const now = Date.now()
  const rows = (msgs || [])
    .filter((m) => m && m.role && m.role !== 'approval')
    .map((m, index) => ({
      conversation_id: conversationId,
      user_id: userId,
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
      model: m.model || null,
      data: m,
      created_at: new Date(now + index).toISOString(),
    }))
  if (!rows.length) return
  const { error } = await supabase.from('conversation_messages').insert(rows)
  if (error) throw error
  await touchConversation(conversationId)
}
