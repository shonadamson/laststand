import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

export async function loadLeagueState() {
  const { data, error } = await supabase
    .from('league_state')
    .select('*')
    .eq('id', 1)
    .single()
  if (error) { console.error('Load error:', error); return null; }
  return data?.state || null
}

export async function saveLeagueState(state) {
  try {
    const { error } = await supabase
      .from('league_state')
      .upsert({ id: 1, state, updated_at: new Date().toISOString() }, { onConflict: 'id' })
    if (error) {
      console.error('Save error:', error)
      return false
    }
    return true
  } catch(e) {
    console.error('Save exception:', e)
    return false
  }
}

export function subscribeToState(callback) {
  return supabase
    .channel('league_state_changes')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'league_state',
      filter: 'id=eq.1'
    }, (payload) => {
      if (payload.new?.state) callback(payload.new.state)
    })
    .subscribe()
}
