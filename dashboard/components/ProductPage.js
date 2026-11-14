import Link from 'next/link';
import TopBar from '@/components/TopBar';
import pages from '@/lib/productPages';
import seo from '@/lib/seo';
import { inviteUrl } from '@/lib/discord';

/** One public product page (lib/productPages.js), with the other products linked below. */
export default function ProductPage({ slug }) {
    const page = pages.PRODUCT_PAGES.find((p) => p.slug === slug);
    let invite = null;
    try { invite = inviteUrl(); } catch { invite = null; }
    const faqLd = page.faq?.length ? seo.faqJsonLd(page.faq) : null;
    return (
        <div className="shell">
            <TopBar />
            {faqLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: seo.jsonLdScript(faqLd) }} /> : null}
            <main className="product-page">
                <nav aria-label="Breadcrumb" className="small muted"><Link href="/">Home</Link> › {page.nav}</nav>
                <h1>{page.h1}</h1>
                <p className="product-lead">{page.lead}</p>
                <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                    {slug === 'studio' || slug === 'automation'
                        ? <Link className="btn btn-primary btn-lg" href="/studio">Open ZiGBoT Studio</Link>
                        : invite ? <a className="btn btn-primary btn-lg" href={invite} target="_blank" rel="noreferrer">➕ Add to Discord</a> : null}
                    <Link className="btn btn-lg" href="/pricing">See pricing</Link>
                </div>
                {page.sections.map((s) => (
                    <section key={s.h2} className="card product-section">
                        <h2>{s.h2}</h2>
                        <p className="muted">{s.text}</p>
                        <ul>{s.points.map((p) => <li key={p}>{p}</li>)}</ul>
                    </section>
                ))}
                {page.faq?.length ? (
                    <section className="product-section">
                        <h2>Questions</h2>
                        {page.faq.map((f) => <details key={f.q} className="l-faq-item"><summary>{f.q}</summary><p className="muted">{f.a}</p></details>)}
                    </section>
                ) : null}
                <nav className="product-more" aria-label="Other ZiGBoT products">
                    <h2>Explore ZiGBoT</h2>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        {pages.PRODUCT_PAGES.filter((p) => p.slug !== slug).map((p) => <Link key={p.slug} className="pill" href={p.path}>{p.nav}</Link>)}
                        <Link className="pill" href="/pricing">Pricing</Link>
                        <Link className="pill" href="/commands">Commands</Link>
                    </div>
                </nav>
            </main>
        </div>
    );
}
