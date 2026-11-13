import Link from 'next/link';

export const metadata = { title: 'Not found · ZiGBoT', robots: { index: false, follow: false } };

// 404 for missing pages, and for private pages you cannot open (same answer, so nothing leaks).
export default function NotFound() {
    return (
        <div className="shell" style={{ paddingTop: 48 }}>
            <div className="card stack" style={{ maxWidth: 560 }}>
                <h1 style={{ margin: 0 }}>Page not found</h1>
                <p className="muted">It may have moved, or it belongs to another account.</p>
                <div className="row" style={{ gap: 8 }}>
                    <Link className="btn btn-primary" href="/">Home</Link>
                    <Link className="btn" href="/dashboard">Dashboard</Link>
                    <Link className="btn" href="/studio">ZiGBoT Studio</Link>
                </div>
            </div>
        </div>
    );
}
