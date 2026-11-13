import { handler, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { loadConfig } from '@/lib/guildData';
import porting from '@/lib/shared/configPorting';

export const dynamic = 'force-dynamic';

// GET: download THIS server's settings as a JSON backup. Server owner only
// (live Discord check). Holds settings only: no tokens, billing or identity.
export const GET = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const { supabase, guild, decision } = await requireGuildAdmin(guildId);
    if (!decision?.isOwner) throw new HttpError(403, 'Only the server owner can export settings.');
    const body = porting.buildExport(await loadConfig(supabase, guild), { guildId: guild.id, guildName: guild.name });
    return new Response(JSON.stringify(body, null, 2), {
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="zigbot-settings-${guild.id}-${new Date().toISOString().slice(0, 10)}.json"`,
            'Cache-Control': 'no-store'
        }
    });
});
