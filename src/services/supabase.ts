import { createClient, SupabaseClient } from '@supabase/supabase-js';
import logger from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/timeout.js';

let supabase: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceRoleKey) {
      logger.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
      throw new Error('Supabase configuration missing');
    }

    const timeoutFetch: typeof fetch = async (input, init = {}) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      const signal =
        init.signal && 'any' in AbortSignal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal;

      try {
        return await fetch(input, { ...init, signal });
      } finally {
        clearTimeout(timeout);
      }
    };

    supabase = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        fetch: timeoutFetch,
      },
    });

    logger.info('Supabase client initialized');
  }

  return supabase;
}

export default getSupabaseClient;
