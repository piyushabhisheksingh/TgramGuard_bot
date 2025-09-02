import { createClient } from '@supabase/supabase-js';

let client = null;

export function getSupabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  client = createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { 'x-application-name': 'tg-group-security-bot' } },
  });
  return client;
}
