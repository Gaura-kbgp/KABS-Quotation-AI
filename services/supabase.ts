import { createClient } from '@supabase/supabase-js';

// Configuration: Read from Environment Variables or Fallback to provided defaults
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.VITE_SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("Critical Error: Supabase URL or Key is missing. Check your .env file.");
}

// Standard Client (for read operations)
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Admin Client (for Storage Buckets & Table Management)
// NOTE: In a real production app, this key should stay server-side. 
// Used here to satisfy the "Direct Connection" and "Create Separate Table/Storage" requirement from the frontend.
// We disable auth persistence here to avoid "Multiple GoTrueClient instances" warning since admin doesn't need user session storage.
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    storageKey: 'kabs_admin_auth_token' // Unique key to prevent conflict with public client
  }
});
