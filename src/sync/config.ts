/**
 * Where Scrumly syncs to. Both values are from the Supabase dashboard, under
 * Project Settings -> API. They are safe to publish: the key only lets someone
 * talk to the project, and row level security (supabase/schema.sql) means a
 * signed-in user can only reach their own rows.
 *
 * VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY override these at build time.
 * Set both to empty strings and the app behaves exactly as it did before sync
 * existed.
 */
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? 'https://ssdysetultzbxwmrmpzi.supabase.co'
export const SUPABASE_ANON_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_rYw59aeNiVwOjAFr7uk4qw_BOfdIVCD'

export const syncConfigured = (): boolean => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
