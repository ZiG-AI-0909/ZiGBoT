import { redirect } from 'next/navigation';
import Link from 'next/link';
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
            <p className="small muted" style={{ marginTop: 0 }}>ZiGBoT Studio · Create. Customize. Code. Deploy. · <Link href="/studio/marketplace">Marketplace</Link></p>
            <StudioProjects />
        </div>
    );
}
