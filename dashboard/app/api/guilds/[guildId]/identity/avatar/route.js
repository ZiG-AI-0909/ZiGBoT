import { NextResponse } from 'next/server';
import shared from '@/lib/shared';
import { handler, HttpError } from '@/lib/http';
import { requireGuildAdmin, requireUser } from '@/lib/auth';
import { getIdentityRow, downloadAvatar, isBotOwner } from '@/lib/identity';

const { SNOWFLAKE } = shared;

export const dynamic = 'force-dynamic';

// GET ?slot=live|pending: a stored avatar, for this server's admins or the
// bot owner (review page). Served from our own origin, never cached.
export const GET = handler(async (request, { params }) => {
    const { guildId } = await params;
    if (!SNOWFLAKE.test(String(guildId || ''))) throw new HttpError(400, 'Invalid server id.');
    const current = await requireUser();
    if (!isBotOwner(current.discordId)) await requireGuildAdmin(guildId);
    const slot = new URL(request.url).searchParams.get('slot') === 'pending' ? 'pending' : 'live';
    const row = await getIdentityRow(guildId);
    const path = slot === 'pending' ? row?.pending_avatar_path : row?.avatar_path;
    if (!path) throw new HttpError(404, 'No picture.');
    const png = await downloadAvatar(path);
    return new NextResponse(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' }
    });
});
