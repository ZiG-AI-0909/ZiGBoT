import AdSense from '@/components/AdSense';
import ProductPage from '@/components/ProductPage';
import seo from '@/lib/seo';

// Title, description, canonical and sharing tags: lib/seo.js (content: lib/productPages.js).
export const metadata = seo.pageMetadata('/features/automation');

export default function Page() {
    return (
        <>
            <AdSense />
            <ProductPage slug="automation" />
        </>
    );
}
