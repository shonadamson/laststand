import { createClient } from '@supabase/supabase-js'

// These get replaced with your real values from Supabase dashboard
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ── Database helpers ──────────────────────────────────────────────────────────

// Load the entire league state from Supabase (single row in league_state table)
export async function loadLeagueState() {
  const { data, error } = await supabase
    .from('league_state')
    .select('*')
    .eq('id', 1)
    .single()
  if (error || !data) return null
  return data.state
}

// Save the entire league state back to Supabase
export async function saveLeagueState(state) {
  const { error } = await supabase
    .from('league_state')
    .upsert({ id: 1, state, updated_at: new Date().toISOString() })
  if (error) console.error('Save error:', error)
}

// Subscribe to real-time state changes
export function subscribeToState(callback) {
  return supabase
    .channel('league_state_changes')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'league_state',
      filter: 'id=eq.1'
    }, (payload) => {
      if (payload.new?.state) callback(payload.new.state)
    })
    .subscribe()
}
