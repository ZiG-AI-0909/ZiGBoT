import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

// Lightweight liveness probe; reports configuration presence only (never values).
// ?deep=1 also checks the database with one tiny read (Section M); the default
// answer is unchanged.
export async function GET(request) {
    const configured = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID']
        .every((name) => Boolean(process.env[name]));
    const body = { ok: true, configured, preview: Boolean(process.env.NVIDIA_API_KEY) };
    if (new URL(request.url).searchParams.get('deep') === '1') {
        let database = 'unconfigured';
        if (configured) {
            try {
                const { error } = await createServiceClient().from('zb_guilds').select('guild_id', { head: true, count: 'exact' }).limit(1);
                database = error ? 'error' : 'ok';
            } catch {
                database = 'error';
            }
        }
        body.database = database;
        body.ok = database !== 'error';
    }
    return NextResponse.json(body, { status: body.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
