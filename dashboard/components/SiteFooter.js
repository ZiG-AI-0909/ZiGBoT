import Link from 'next/link';
import { PORTFOLIO_CONTACT_URL } from '@/lib/discord';
import seo from '@/lib/seo';

// Small monochrome icons (inline SVG: no external requests, CSP-safe).
const ICONS = {
    discord: 'M20 5.5A16 16 0 0 0 16 4l-.5 1a14 14 0 0 0-7 0L8 4a16 16 0 0 0-4 1.5C1.5 9.3.8 13 1.1 16.6A16 16 0 0 0 6 19l1-1.6c-.9-.3-1.7-.8-2.4-1.3l.6-.5a11.5 11.5 0 0 0 9.6 0l.6.5c-.7.5-1.5 1-2.4 1.3l1 1.6a16 16 0 0 0 4.9-2.4c.4-4.2-.6-7.9-2.9-11.1zM8.7 14.3c-.9 0-1.7-.9-1.7-2s.8-2 1.7-2 1.7.9 1.7 2-.8 2-1.7 2zm6.6 0c-.9 0-1.7-.9-1.7-2s.8-2 1.7-2 1.7.9 1.7 2-.8 2-1.7 2z',
    youtube: 'M22 8.2a3 3 0 0 0-2.1-2.1C18 5.6 12 5.6 12 5.6s-6 0-7.9.5A3 3 0 0 0 2 8.2 31 31 0 0 0 1.6 12 31 31 0 0 0 2 15.8a3 3 0 0 0 2.1 2.1c1.9.5 7.9.5 7.9.5s6 0 7.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .4-3.8 31 31 0 0 0-.4-3.8zM10 15V9l5.2 3z',
    instagram: 'M12 7.3a4.7 4.7 0 1 0 0 9.4 4.7 4.7 0 0 0 0-9.4zm0 7.7a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm6-7.9a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 0 1 2.2 0zM17 2H7a5 5 0 0 0-5 5v10a5 5 0 0 0 5 5h10a5 5 0 0 0 5-5V7a5 5 0 0 0-5-5zm3.3 15A3.3 3.3 0 0 1 17 20.3H7A3.3 3.3 0 0 1 3.7 17V7A3.3 3.3 0 0 1 7 3.7h10A3.3 3.3 0 0 1 20.3 7z',
    list: 'M4 6h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zm-4 5h2v2H4zm4 0h12v2H8z',
    link: 'M10.6 13.4a1 1 0 0 1 0-1.4l3.4-3.4a1 1 0 1 1 1.4 1.4L12 13.4a1 1 0 0 1-1.4 0zM8.2 18.6a3.4 3.4 0 0 1-4.8-4.8l2.8-2.8 1.4 1.4-2.8 2.8a1.4 1.4 0 0 0 2 2l2.8-2.8 1.4 1.4zm9.6-6.8-1.4-1.4 2.8-2.8a1.4 1.4 0 0 0-2-2l-2.8 2.8-1.4-1.4 2.8-2.8a3.4 3.4 0 0 1 4.8 4.8z'
};

export default function SiteFooter() {
    const socials = seo.socialLinks();
    return (
        <footer className="site-footer">
            <span>© {new Date().getFullYear()} ZiGBoT</span>
            <nav className="row footer-social" aria-label="ZiGBoT on social media">
                {socials.map((s) => (
                    <a key={s.url} href={s.url} target="_blank" rel="me noopener noreferrer" title={s.label} aria-label={s.label}>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d={ICONS[s.icon] || ICONS.link} /></svg>
                        <span className="footer-social-label">{s.label}</span>
                    </a>
                ))}
            </nav>
            <nav className="row" aria-label="Site">
                <Link href="/commands">Commands</Link>
                <Link href="/terms">Terms of Service</Link>
                <Link href="/privacy">Privacy Policy</Link>
                <a href={PORTFOLIO_CONTACT_URL} target="_blank" rel="noreferrer">Contact</a>
            </nav>
        </footer>
    );
}
