/**
 * Search and sharing metadata: ONE place for the canonical origin, the public
 * pages, the robots rules and the JSON-LD. Used by app/robots.js,
 * app/sitemap.js and the pages' metadata; checked by test/seo.test.js.
 * CommonJS like lib/landing.js, so the root test suite can load it.
 *
 * Canonical origin: https://zigbotai.vercel.app (no custom domain yet).
 * Only claims that are visible on the page go into structured data: no
 * ratings, reviews, prices or user counts.
 */
const CANONICAL_ORIGIN = 'https://zigbotai.vercel.app';
const SITE_NAME = 'ZiGBoT';
// Search engine ownership checks (public tokens, not secrets). Google also
// has the HTML-file method: public/google4f033dbcc41e6d42.html.
const SITE_VERIFICATION = Object.freeze({ google: 'cWplGzZ-DLyFscyRzBmgugKqMVFaMEkEy8cwa4Zx33o' });
const OG_IMAGE = Object.freeze({ path: '/opengraph-image', width: 1200, height: 630, alt: 'ZiGBoT, the ZiG mascot, a Discord bot with a personality and memory you control' });

/** Indexable pages, each with a unique title and description. */
const PUBLIC_PAGES = Object.freeze([
    Object.freeze({
        path: '/',
        title: 'ZiGBoT · the Discord bot with a personality and memory you control',
        description: 'ZiGBoT chats, roasts (nicely), plays music and helps moderate your Discord server — and lets you see, fix and delete anything it remembers about you.'
    }),
    Object.freeze({
        path: '/commands',
        title: 'Commands · ZiGBoT',
        description: 'Every ZiGBoT slash command for members and admins, with examples, plus what you can ask ZiGBoT by mentioning it.'
    }),
    Object.freeze({
        path: '/privacy',
        title: 'Privacy Policy · ZiGBoT',
        description: 'What data ZiGBoT collects, why, who processes it, and how long it is kept.'
    }),
    Object.freeze({
        path: '/terms',
        title: 'Terms of Service · ZiGBoT',
        description: 'The rules for using the ZiGBoT Discord bot and its dashboard.'
    })
]);

/** Never indexed: signed-in areas, the owner's tools, the API and login steps. */
const PRIVATE_PATHS = Object.freeze(['/dashboard', '/owner', '/admin', '/api', '/auth']);

// Search crawlers we name explicitly. GPTBot (OpenAI model training) is
// allowed on public pages only, by the owner's decision; OAI-SearchBot is
// ChatGPT Search. Everyone else falls under '*', with the same rules.
const NAMED_CRAWLERS = Object.freeze(['Googlebot', 'Bingbot', 'OAI-SearchBot', 'GPTBot']);

const absolute = (path = '/') => `${CANONICAL_ORIGIN}${path === '/' ? '/' : path}`;

/** Next.js metadata for one public page: title, description, canonical, Open Graph, Twitter. */
function pageMetadata(path) {
    const page = PUBLIC_PAGES.find((p) => p.path === path);
    if (!page) throw new Error(`No public page metadata for ${path}`);
    const image = { url: absolute(OG_IMAGE.path), width: OG_IMAGE.width, height: OG_IMAGE.height, alt: OG_IMAGE.alt };
    return {
        title: page.title,
        description: page.description,
        alternates: { canonical: absolute(page.path) },
        robots: { index: true, follow: true },
        openGraph: { type: 'website', url: absolute(page.path), siteName: SITE_NAME, title: page.title, description: page.description, images: [image], locale: 'en_US' },
        twitter: { card: 'summary_large_image', title: page.title, description: page.description, images: [image.url] }
    };
}

/** Metadata for private areas: never indexed or followed. */
const PRIVATE_METADATA = Object.freeze({ robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } });

function robotsRules() {
    // robots.txt paths are prefixes: "/dashboard" also covers "/dashboard/…".
    const rule = (userAgent) => ({ userAgent, allow: '/', disallow: [...PRIVATE_PATHS] });
    return {
        rules: [...NAMED_CRAWLERS.map(rule), rule('*')],
        sitemap: absolute('/sitemap.xml')
    };
}

function sitemapEntries(lastModified = new Date()) {
    return PUBLIC_PAGES.map((page) => ({
        url: absolute(page.path),
        lastModified,
        changeFrequency: page.path === '/' || page.path === '/commands' ? 'weekly' : 'monthly',
        priority: page.path === '/' ? 1 : 0.6
    }));
}

/** SoftwareApplication JSON-LD for the homepage, from the same text the page shows. */
function softwareApplicationJsonLd({ description, features = [] }) {
    return {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        url: absolute('/'),
        image: absolute(OG_IMAGE.path),
        applicationCategory: 'CommunicationApplication',
        operatingSystem: 'Discord',
        description,
        featureList: features.map((f) => `${f.title}${f.badge ? ` (${f.badge})` : ''}`)
    };
}

/** FAQPage JSON-LD: only for an FAQ that is visible on the same page. */
function faqJsonLd(faq) {
    return {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faq.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } }))
    };
}

/** JSON for a <script type="application/ld+json">, safe against "</script>" in text. */
function jsonLdScript(data) {
    return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

module.exports = {
    CANONICAL_ORIGIN,
    SITE_NAME,
    SITE_VERIFICATION,
    OG_IMAGE,
    PUBLIC_PAGES,
    PRIVATE_PATHS,
    NAMED_CRAWLERS,
    PRIVATE_METADATA,
    absolute,
    pageMetadata,
    robotsRules,
    sitemapEntries,
    softwareApplicationJsonLd,
    faqJsonLd,
    jsonLdScript
};
