/**
 * StanceAI — Supabase Client
 * ===========================
 * Singleton client shared across the entire frontend.
 * Credentials are read from Vite environment variables (prefixed VITE_).
 *
 * Required in frontend/.env:
 *   VITE_SUPABASE_URL=https://xxxx.supabase.co
 *   VITE_SUPABASE_ANON_KEY=eyJh...
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseKey  = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

if (!supabaseUrl || !supabaseKey) {
  console.error(
    '[StanceAI] Missing Supabase env vars.\n' +
    'Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to frontend/.env'
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    // Disable persistent sessions for now (no auth required)
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
});

export default supabase;
