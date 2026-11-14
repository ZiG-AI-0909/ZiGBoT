import Link from 'next/link';
import TopBar from '@/components/TopBar';
import AdSense from '@/components/AdSense';
import pages from '@/lib/productPages';
import pricing from '@/lib/pricing';
import seo from '@/lib/seo';
import { env } from '@/lib/env';

// Title, description, canonical and sharing tags: lib/seo.js.
export const metadata = seo.pageMetadata('/pricing');
export const dynamic = 'force-dynamic';

// Prices come from the configured labels (the real amounts live in the
// Razorpay plans); nothing is shown if they are not set.
export default function Pricing() {
    let prices = { monthly: '', yearly: '' };
    try { prices = env.premiumPriceLabels; } catch { /* not configured */ }
    const savings = pricing.yearlySavings(prices);
    const { PRICING } = pages;
    return (
        <div className="shell">
            <AdSense />
            <TopBar />
            <main className="product-page">
                <h1>Pricing</h1>
                <p className="product-lead">Start free. Upgrade a server to Premium when you want music, voice, a custom persona and live automations. Premium is per server, and its admins also get Studio Premium.</p>
                <div className="pricing-grid">
                    <section className="card pricing-card">
                        <h2>Free</h2>
                        <p className="pricing-price">₹0</p>
                        <ul>{PRICING.free.map((f) => <li key={f}>{f}</li>)}</ul>
                        <Link className="btn btn-lg" href="/dashboard">Get started</Link>
                    </section>
                    <section className="card pricing-card is-best">
                        <h2>💎 Premium</h2>
                        {prices.yearly ? <p className="pricing-price">{prices.yearly}{savings ? <span className="pill pill-premium" style={{ marginLeft: 8 }}>Best value · {savings.text}</span> : null}</p> : null}
                        {prices.monthly ? <p className="muted">or {prices.monthly}</p> : null}
                        <ul>{PRICING.premium.map((f) => <li key={f}>{f}</li>)}</ul>
                        <Link className="btn btn-primary btn-lg" href="/dashboard">Upgrade a server</Link>
                        <p className="help">Paid securely through Razorpay. Cancel any time: Premium stays active until the end of the period you paid for.</p>
                    </section>
                </div>
                <p className="help">Always free: moderation, Anti-Nuke, and the memory and privacy controls.</p>
            </main>
        </div>
    );
}
