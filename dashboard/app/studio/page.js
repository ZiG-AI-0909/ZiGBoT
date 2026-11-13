import { redirect } from 'next/navigation';
import Link from 'next/link';
import specs from '@/lib/studio/specializations';
import TopBar from '@/components/TopBar';
import StudioProjects from '@/components/studio/StudioProjects';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// ZiGBoT Studio: create, customize and program your own Discord bots.
export default async function StudioHome() {
    const current = await getCurrentUser();
    if (!current) redirect('/');
    const { data: profile } = await current.supabase.from('zb_profiles').select('username, avatar_url').eq('user_id', current.user.id).maybeSingle();
    return (
        <div className="shell">
            <TopBar profile={profile} />
            <section className="studio-hero" aria-labelledby="studio-hero-title">
                <h1 id="studio-hero-title">ZiGBoT Studio</h1>
                <p className="muted" style={{ margin: '6px 0 0', maxWidth: 640 }}>Build. Automate. Create. Code your own Discord bot, design automations visually and turn prompts into reviewed code, then run it on your own machine.</p>
                <div className="studio-modes">
                    {specs.SPECIALIZATIONS.map((s) => (
                        <Link key={s.id} href="/studio/new" className="studio-mode" style={{ '--spec': s.accent }}>
                            <strong>{s.title}</strong>
                            <span className="help">{s.tagline}</span>
                        </Link>
                    ))}
                </div>
                <p className="small muted" style={{ margin: '14px 0 0' }}><Link href="/studio/marketplace">Browse the template marketplace →</Link></p>
            </section>
            <StudioProjects />
        </div>
    );
}
