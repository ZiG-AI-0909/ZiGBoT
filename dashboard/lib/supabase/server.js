import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { env } from '../env';

/**
 * User-scoped client: authenticates as the logged-in user via their session
 * cookie and the PUBLIC anon key, so every query is subject to RLS.
 */
export async function createUserClient() {
    const cookieStore = await cookies();
    return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
        cookies: {
            getAll() {
                return cookieStore.getAll();
            },
            setAll(cookiesToSet) {
                try {
                    for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
                } catch {
                    // Called from a Server Component: middleware refreshes the session instead.
                }
            }
        }
    });
}

/**
 * Service-role client. BYPASSES RLS — use only after the caller has been
 * verified server-side, and only for writes users must never make
 * themselves (profiles, OAuth guild lists, verification records).
 */
let serviceClient = null;
export function createServiceClient() {
    if (!serviceClient) {
        serviceClient = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
    }
    return serviceClient;
}
