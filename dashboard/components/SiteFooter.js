import Link from 'next/link';

export default function SiteFooter() {
    return (
        <footer className="site-footer">
            <span>© {new Date().getFullYear()} ZiGBoT</span>
            <nav className="row" aria-label="Site">
                <Link href="/commands">Commands</Link>
                <Link href="/terms">Terms of Service</Link>
                <Link href="/privacy">Privacy Policy</Link>
            </nav>
        </footer>
    );
}
