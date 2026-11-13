import { notFound } from 'next/navigation';
import { getSuperAdmin } from '@/lib/admin';
import { createServiceClient } from '@/lib/supabase/server';
import { When } from '@/components/admin/ui';
import RevealKey from '@/components/admin/RevealKey';

export const dynamic = 'force-dynamic';

// Coding-agent API keys users connected in ZiGBoT Studio, with their usage.
// Keys stay masked; a Super Admin can reveal one at a time (audit-logged).
export default async function AdminAgentKeys() {
    if (!(await getSuperAdmin())) notFound();
    const db = createServiceClient();
    const { data: keys, error } = await db.from('studio_agent_keys').select('owner_id, provider, last4, model, updated_at').order('updated_at', { ascending: false }).limit(500);
    const ownerIds = [...new Set((keys || []).map((k) => k.owner_id))];
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const [{ data: profiles }, { data: runs }] = ownerIds.length ? await Promise.all([
        db.from('zb_profiles').select('user_id, username, discord_user_id').in('user_id', ownerIds),
        db.from('studio_agent_runs').select('owner_id, provider, status, input_tokens, output_tokens').in('owner_id', ownerIds).gte('created_at', since).limit(20000)
    ]) : [{ data: [] }, { data: [] }];
    const who = new Map((profiles || []).map((p) => [p.user_id, p]));
    const usage = new Map();
    for (const r of runs || []) {
        const k = `${r.owner_id}:${r.provider}`;
        const u = usage.get(k) || { runs: 0, failed: 0, tokens: 0 };
        u.runs += 1; if (r.status !== 'done') u.failed += 1; u.tokens += (r.input_tokens || 0) + (r.output_tokens || 0);
        usage.set(k, u);
    }
    return (
        <>
            <header className="adm-top"><h1>Agent API keys</h1><span className="help">Claude / OpenAI keys users connected in Studio · usage over the last 30 days</span></header>
            <p className="help">Keys are stored encrypted. Revealing one shows the full key for 30 seconds and is recorded in the audit log (Settings &amp; Audit). Users are told admins can view their keys.</p>
            {error ? <div className="notice" role="alert">Agent key storage is not set up yet: run the newest files in supabase/migrations.</div> : null}
            <div className="adm-table-wrap">
                <table className="adm-table">
                    <thead><tr><th>User</th><th>Provider</th><th>Model</th><th>Key</th><th>Runs (30 d)</th><th>Tokens (30 d)</th><th>Updated</th></tr></thead>
                    <tbody>
                        {(keys || []).length === 0 ? <tr><td colSpan={7} className="help">No keys connected yet.</td></tr> : keys.map((k) => {
                            const p = who.get(k.owner_id);
                            const u = usage.get(`${k.owner_id}:${k.provider}`) || { runs: 0, failed: 0, tokens: 0 };
                            return (
                                <tr key={`${k.owner_id}-${k.provider}`}>
                                    <td><a href={`/admin/users/${k.owner_id}`}><strong>{p?.username || '(no name)'}</strong></a><div className="help"><code>{p?.discord_user_id || k.owner_id}</code></div></td>
                                    <td>{k.provider === 'anthropic' ? 'Claude (Anthropic)' : 'OpenAI'}</td>
                                    <td><code>{k.model || 'default'}</code></td>
                                    <td><RevealKey ownerId={k.owner_id} provider={k.provider} last4={k.last4} /></td>
                                    <td>{u.runs}{u.failed ? <span className="help"> ({u.failed} not completed)</span> : null}</td>
                                    <td>{u.tokens.toLocaleString('en-IN')}</td>
                                    <td><When at={k.updated_at} /></td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </>
    );
}
