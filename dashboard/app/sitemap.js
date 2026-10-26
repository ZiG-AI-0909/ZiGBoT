import seo from '@/lib/seo';

// /sitemap.xml: only the canonical, indexable public pages.
export default function sitemap() {
    return seo.sitemapEntries();
}
