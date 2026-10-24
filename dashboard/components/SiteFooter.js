import Link from 'next/link';
import { contactUrl } from '@/lib/discord';

export default function SiteFooter() {
    const contact = contactUrl();
    return (
        <footer className="site-footer">
            <span>© {new Date().getFullYear()} ZiGBoT</span>
            <nav className="row" aria-label="Site">
                <Link href="/commands">Commands</Link>
                <Link href="/terms">Terms of Service</Link>
                <Link href="/privacy">Privacy Policy</Link>
                {contact ? <a href={contact} target="_blank" rel="noreferrer">Contact</a> : null}
            </nav>
        </footer>
    );
}
