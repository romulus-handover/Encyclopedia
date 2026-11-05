import { AuthClient } from '@supabase/auth-js';

// #431 — CRA -> Vite migration: process.env.REACT_APP_* -> import.meta.env.VITE_*.
// Publishable key (sb_publishable_...) replaces the legacy JWT anon key.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy frontend/.env.example to frontend/.env.local and use the publishable key from Supabase Settings > API Keys.',
  );
}

// Bundle-size fix — this app only ever calls supabase.auth.* (sign in/up/out,
// session, password reset, OAuth). It never queries Postgres directly, never
// touches Storage, and never opens a Realtime channel — backend/src is the
// only thing that talks to the database. The full @supabase/supabase-js
// package unconditionally constructs all four sub-clients (auth, postgrest,
// storage, realtime — including realtime's websocket/phoenix machinery) as
// soon as createClient() is called, even though this app only ever uses one
// of them, which was most of the size flagged by the >500kB build warning.
//
// @supabase/auth-js's AuthClient gives identical auth behavior: verified
// directly against supabase-js@2.109.0's own published source — its
// `supabase.auth` is literally `new SupabaseAuthClient(...)`, and
// SupabaseAuthClient is just `class SupabaseAuthClient extends AuthClient`
// with zero overrides. The config below (url, headers, storageKey, and the
// auth option defaults) is copied from supabase-js's own
// _initSupabaseAuthClient()/constructor so existing logged-in users' sessions
// (stored under this exact storageKey in localStorage) keep working rather
// than silently signing everyone out.
const projectRef = new URL(supabaseUrl).hostname.split('.')[0];

export const supabase = {
  auth: new AuthClient({
    url: `${supabaseUrl}/auth/v1`,
    headers: {
      // New API keys are not JWTs. Send them only as apikey; Authorization
      // is reserved for the user's session token after sign-in.
      apikey: supabasePublishableKey,
    },
    storageKey: `sb-${projectRef}-auth-token`,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    flowType: 'implicit',
    hasCustomAuthorizationHeader: false,
  }),
};