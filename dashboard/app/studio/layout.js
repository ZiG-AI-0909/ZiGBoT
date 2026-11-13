import seo from '@/lib/seo';

// ZiGBoT Studio pages are private (never indexed).
export const metadata = { title: 'ZiGBoT Studio', ...seo.PRIVATE_METADATA };

export default function StudioLayout({ children }) {
    return children;
}
