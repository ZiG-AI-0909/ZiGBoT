import seo from '@/lib/seo';
import FeedbackPrompt from '@/components/FeedbackPrompt';
import AppShell from '@/components/AppShell';
import { PORTFOLIO_CONTACT_URL } from '@/lib/discord';

// Everything under /dashboard is private: never indexed or followed
// (next.config.mjs also sends X-Robots-Tag for these paths).
export const metadata = { title: 'ZiGBoT Dashboard', ...seo.PRIVATE_METADATA };

export default function DashboardLayout({ children }) {
    // First-purchase Premium feedback: shows only for a buyer with a pending form.
    return (
        <AppShell contactUrl={PORTFOLIO_CONTACT_URL}>
            {children}
            <FeedbackPrompt />
        </AppShell>
    );
}
