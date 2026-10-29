import seo from '@/lib/seo';
import FeedbackPrompt from '@/components/FeedbackPrompt';

// Everything under /dashboard is private: never indexed or followed
// (next.config.mjs also sends X-Robots-Tag for these paths).
export const metadata = { title: 'ZiGBoT Dashboard', ...seo.PRIVATE_METADATA };

export default function DashboardLayout({ children }) {
    // First-purchase Premium feedback: shows only for a buyer with a pending form.
    return (
        <>
            {children}
            <FeedbackPrompt />
        </>
    );
}
