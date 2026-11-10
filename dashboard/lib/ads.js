/**
 * Google AdSense: ONE place for the publisher ID, the ads.txt line and the
 * extra Content-Security-Policy sources ads need. Ads run on the public
 * pages only (lib/seo.js PUBLIC_PAGES); the dashboard, /admin, /owner,
 * /welcome and the API keep the strict policy. Used by next.config.mjs,
 * components/AdSense.js and public/ads.txt; checked by test/ads.test.js.
 * CommonJS like lib/seo.js, so next.config and the test suite can load it.
 *
 * The publisher ID is public (it is in every page that shows ads).
 */
const ADSENSE_CLIENT = 'ca-pub-6170894801860429';
const SCRIPT_URL = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`;

// public/ads.txt must hold exactly this line (f08c47fec0942fa0 is Google's
// fixed certification authority ID).
const ADS_TXT = `google.com, ${ADSENSE_CLIENT.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0`;

// Hosts AdSense, its consent message (Funding Choices) and its ad-quality
// checks load from. Ad images come from many advertiser CDNs, so images
// allow any https source on these pages.
const GOOGLE_AD_HOSTS = [
    'https://*.googlesyndication.com',
    'https://*.doubleclick.net',
    'https://*.googleadservices.com',
    'https://*.google.com',
    'https://*.google.co.in',
    'https://*.gstatic.com',
    'https://*.adtrafficquality.google',
    'https://fundingchoicesmessages.google.com'
];

const AD_CSP = Object.freeze({
    'img-src': ['https:'],
    'script-src': GOOGLE_AD_HOSTS,
    'frame-src': GOOGLE_AD_HOSTS,
    'connect-src': GOOGLE_AD_HOSTS
});

/** The page CSP plus the ad sources: directives (['name value', ...]) in, same shape out. */
function withAdSources(directives) {
    return directives.map((directive) => {
        const name = directive.split(' ')[0];
        return AD_CSP[name] ? `${directive} ${AD_CSP[name].join(' ')}` : directive;
    });
}

module.exports = { ADSENSE_CLIENT, SCRIPT_URL, ADS_TXT, AD_CSP, withAdSources };
