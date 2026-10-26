import { Bebas_Neue } from 'next/font/google';
import './globals.css';
import SiteFooter from '@/components/SiteFooter';
import seo from '@/lib/seo';

// Display face for headings, matching the banner's bold caps. Self-hosted by
// next/font at build time, so the CSP needs no external font origin.
const display = Bebas_Neue({ weight: '400', subsets: ['latin'], variable: '--font-display', display: 'swap' });

// metadataBase: every canonical / Open Graph URL resolves against the one
// canonical origin (lib/seo.js), never the request's host.
export const metadata = {
    metadataBase: new URL(seo.CANONICAL_ORIGIN),
    // Google Search Console ownership (meta-tag method).
    verification: { google: seo.SITE_VERIFICATION.google },
    title: 'ZiGBoT Dashboard',
    description: 'Configure ZiGBoT for your Discord servers: AI personality, role behaviour, and channels.'
};

export const viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }) {
    return (
        <html lang="en" className={display.variable}>
            <body>
                {children}
                <SiteFooter />
            </body>
        </html>
    );
}
