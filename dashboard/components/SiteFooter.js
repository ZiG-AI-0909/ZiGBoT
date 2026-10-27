import Link from 'next/link';
import { PORTFOLIO_CONTACT_URL } from '@/lib/discord';

export default function SiteFooter() {
    return (
        <footer className="site-footer">
            <span>© {new Date().getFullYear()} ZiGBoT</span>
            <nav className="row" aria-label="Site">
                <Link href="/commands">Commands</Link>
                <Link href="/terms">Terms of Service</Link>
                <Link href="/privacy">Privacy Policy</Link>
                <a href={PORTFOLIO_CONTACT_URL} target="_blank" rel="noreferrer">Contact</a>
            </nav>
        </footer>
    );
}
