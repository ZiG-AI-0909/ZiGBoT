/**
 * Search and sharing metadata: ONE place for the canonical origin, the public
 * pages, the robots rules and the JSON-LD. Used by app/robots.js,
 * app/sitemap.js and the pages' metadata; checked by test/seo.test.js.
 * CommonJS like lib/landing.js, so the root test suite can load it.
 *
 * Canonical origin: https://www.zigbot.in (zigbot.in redirects here).
 * Only claims that are visible on the page go into structured data: no
 * ratings, reviews, prices or user counts.
 */
const CANONICAL_ORIGIN = 'https://www.zigbot.in';
const SITE_NAME = 'ZiGBoT';
// Other spellings people search for, so Google ties them to this site
// instead of "Did you mean: gizbot".
const ALTERNATE_NAMES = Object.freeze(['ZiGBoT Discord bot', 'ZigBot', 'Zig Bot']);
// ZiGBoT's own profiles elsewhere (structured data "sameAs"). Only real,
// public listings of this bot.
const SAME_AS = Object.freeze([
    'https://discord.com/discovery/applications/1539530458390593576',
    'https://discordbotlist.com/bots/zigbot'
]);
// The creator, and his own profiles (Person "sameAs").
const CREATOR = Object.freeze({
    name: 'Bhavesh Kumar Tiwari (ZiG)',
    alternateName: 'YourBoyZiG',
    url: 'https://aibhaveshportfolio.vercel.app/',
    sameAs: Object.freeze([
        'https://linktr.ee/Zignamite',
        'https://www.youtube.com/@yourboyzig',
        'https://www.instagram.com/_yourboyzig/'
    ])
});
// Search engine ownership checks (public tokens, not secrets). Google also
// has the HTML-file method: public/google4f033dbcc41e6d42.html.
const SITE_VERIFICATION = Object.freeze({ google: 'cWplGzZ-DLyFscyRzBmgugKqMVFaMEkEy8cwa4Zx33o' });
const OG_IMAGE = Object.freeze({ path: '/opengraph-image', width: 1200, height: 630, alt: 'ZiGBoT, your AI-powered Discord command center' });

/** Indexable pages, each with a unique title and description. */
const PUBLIC_PAGES = Object.freeze([
    Object.freeze({
        path: '/',
        title: 'ZiGBoT · Your AI-Powered Discord Command Center',
        description: 'More than a chatbot: an AI platform to chat, code your own Discord bot, design automations and manage your server, with memory you control.'
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
const PRIVATE_PATHS = Object.freeze(['/dashboard', '/owner', '/admin', '/api', '/auth', '/studio']);

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
        alternateName: [...ALTERNATE_NAMES],
        url: absolute('/'),
        image: absolute(OG_IMAGE.path),
        sameAs: [...SAME_AS],
        author: { '@type': 'Person', name: CREATOR.name, alternateName: CREATOR.alternateName, url: CREATOR.url, sameAs: [...CREATOR.sameAs] },
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Discord',
        description,
        featureList: features.map((f) => `${f.title}${f.badge ? ` (${f.badge})` : ''}`)
    };
}

/** WebSite JSON-LD: the site's name, so search results show "ZiGBoT" as the brand. */
function websiteJsonLd() {
    return {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: SITE_NAME,
        alternateName: [...ALTERNATE_NAMES],
        url: absolute('/')
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
    ALTERNATE_NAMES,
    SAME_AS,
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
    websiteJsonLd,
    faqJsonLd,
    jsonLdScript
};
