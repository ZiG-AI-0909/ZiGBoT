import seo from '@/lib/seo';

// /robots.txt: public pages open to search crawlers (Googlebot, Bingbot,
// OAI-SearchBot, and GPTBot on public pages only); private areas closed.
export default function robots() {
    return seo.robotsRules();
}
