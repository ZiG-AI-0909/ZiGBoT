import seo from '@/lib/seo';
import AppShell from '@/components/AppShell';
import { PORTFOLIO_CONTACT_URL } from '@/lib/discord';

// ZiGBoT Studio pages are private (never indexed).
export const metadata = { title: 'ZiGBoT Studio', ...seo.PRIVATE_METADATA };

export default function StudioLayout({ children }) {
    return (
        <AppShell contactUrl={PORTFOLIO_CONTACT_URL}>
            <div className="studio-theme">
                <div className="studio-bg" aria-hidden="true"><span className="orb orb-a" /><span className="orb orb-b" /><span className="orb orb-c" /><span className="grid" /></div>
                <div className="studio-content">{children}</div>
            </div>
        </AppShell>
    );
}
