import { handler, json } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { loadGuildBundle } from '@/lib/guildData';

export const dynamic = 'force-dynamic';

// GET: full editor bundle (config, role mappings, live roles/channels, bot status).
export const GET = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const access = await requireGuildAdmin(guildId);
    return json(await loadGuildBundle(access));
});
