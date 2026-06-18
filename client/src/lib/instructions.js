import { supabase } from './supabase'

// Data access for the user's global instructions (system prompt).
// RLS guarantees a user only ever reads/writes their own row, so we don't pass
// user_id around the client — the logged-in session scopes everything.

// Returns the saved instruction content (empty string if none yet).
export async function getInstructions() {
  const { data, error } = await supabase
    .from('user_instructions')
    .select('content')
    .maybeSingle()

  if (error) throw error
  return data?.content ?? ''
}

// Upserts the instruction content for the current user.
export async function saveInstructions(content) {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { error } = await supabase.from('user_instructions').upsert(
    {
      user_id: user.id,
      content,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  )

  if (error) throw error
}
