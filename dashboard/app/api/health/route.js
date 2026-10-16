import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Lightweight liveness probe; reports configuration presence only (never values).
export function GET() {
    const configured = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID']
        .every((name) => Boolean(process.env[name]));
    return NextResponse.json({ ok: true, configured, preview: Boolean(process.env.NVIDIA_API_KEY) }, { headers: { 'Cache-Control': 'no-store' } });
}
