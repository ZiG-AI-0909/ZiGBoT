import seo from '@/lib/seo';

// Everything under /dashboard is private: never indexed or followed
// (next.config.mjs also sends X-Robots-Tag for these paths).
export const metadata = { title: 'ZiGBoT Dashboard', ...seo.PRIVATE_METADATA };

export default function DashboardLayout({ children }) {
    return children;
}
