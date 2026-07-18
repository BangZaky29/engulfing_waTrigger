import { createClient } from '@supabase/supabase-js';
import { fetchWithTimeout } from '../utils/helpers';
import { SUPABASE_URL, SUPABASE_KEY } from '../config/env';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  global: {
    fetch: fetchWithTimeout as typeof fetch,
  },
});
