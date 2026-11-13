import 'server-only';
import { env } from '@/lib/env';
import { createServiceClient } from '@/lib/supabase/server';
import ent from '@/lib/studio/entitlements';

/**
 * The signed-in user's automation entitlement, from server-side data only:
 * their Studio plan (+ expiry), the servers they manage (their own RLS rows)
 * and those servers' ZiGBoT Premium subscriptions (service role, read-only,
 * limited to the user's own server ids). Fails closed: any lookup error
 * means "not premium".
 */
export async function getAutomationEntitlement({ supabase, ownerId, discordId }) {
    try {
        let account = null;
        const withExpiry = await supabase.from('studio_accounts').select('plan, plan_expires_at').eq('user_id', ownerId).maybeSingle();
        if (withExpiry.error) {
            const plain = await supabase.from('studio_accounts').select('plan').eq('user_id', ownerId).maybeSingle();
            account = plain.data ? { plan: plain.data.plan, plan_expires_at: null, legacy: true } : null;
        } else account = withExpiry.data;
        // Without the expiry column (migration not run) a paid Studio plan cannot be time-checked: fail closed.
        const studioPlan = account?.legacy ? 'free' : account?.plan || 'free';

        const { data: guilds } = await supabase.from('zb_user_guilds').select('guild_id').eq('can_manage', true).limit(200);
        const ids = (guilds || []).map((g) => String(g.guild_id));
        let subscriptions = [];
        if (ids.length) {
            const { data } = await createServiceClient().from('zb_guild_subscriptions').select('guild_id, status, current_period_end').in('guild_id', ids);
            subscriptions = data || [];
        }
        return ent.resolveAutomationEntitlement({
            studioPlan,
            studioPlanExpiresAt: account?.plan_expires_at ?? null,
            subscriptions,
            managesHomeGuild: ids.some((id) => env.homeGuildIds.includes(id)),
            isBotOwner: Boolean(env.botCreatorId) && String(discordId || '') === env.botCreatorId
        });
    } catch (error) {
        console.error('[studio] entitlement lookup failed:', error?.message);
        return { premium: false, source: null, expiresAt: null, error: true };
    }
}

/**
 * The same entitlement for a project owner WITHOUT a browser session (used
 * when their self-hosted runner deploys): service-role reads limited to that
 * owner's own rows. Fails closed.
 */
export async function getEntitlementForOwner(ownerId) {
    try {
        const db = createServiceClient();
        const [{ data: account }, { data: profile }, { data: guilds }] = await Promise.all([
            db.from('studio_accounts').select('plan, plan_expires_at').eq('user_id', ownerId).maybeSingle(),
            db.from('zb_profiles').select('discord_user_id').eq('user_id', ownerId).maybeSingle(),
            db.from('zb_user_guilds').select('guild_id').eq('user_id', ownerId).eq('can_manage', true).limit(200)
        ]);
        const ids = (guilds || []).map((g) => String(g.guild_id));
        let subscriptions = [];
        if (ids.length) {
            const { data } = await db.from('zb_guild_subscriptions').select('guild_id, status, current_period_end').in('guild_id', ids);
            subscriptions = data || [];
        }
        return ent.resolveAutomationEntitlement({
            studioPlan: account?.plan || 'free',
            studioPlanExpiresAt: account?.plan_expires_at ?? null,
            subscriptions,
            managesHomeGuild: ids.some((id) => env.homeGuildIds.includes(id)),
            isBotOwner: Boolean(env.botCreatorId) && String(profile?.discord_user_id || '') === env.botCreatorId
        });
    } catch (error) {
        console.error('[studio] owner entitlement lookup failed:', error?.message);
        return { premium: false, source: null, expiresAt: null, error: true };
    }
}

/**
 * The plan whose limits apply in Studio. One Premium for both products:
 * a ZiGBoT Premium server (or home server / bot owner) unlocks Studio
 * Premium limits for its admins; a Studio plan counts only while unexpired.
 * 'free' | 'developer' | 'premium'. Fails closed to 'free'.
 */
export async function getEffectivePlan(session) {
    const entitlement = await getAutomationEntitlement(session);
    if (!entitlement.premium) return 'free';
    return entitlement.source === 'studio_developer' ? 'developer' : 'premium';
}

export function paywallBody() {
    return ent.paywall({ priceLabels: env.premiumPriceLabels, billingEnabled: env.billingEnabled });
}
