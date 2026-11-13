import { Fragment } from 'react';
import Link from 'next/link';
import './landing.css';
import TopBar from '@/components/TopBar';
import AdSense from '@/components/AdSense';
import HomeBackground from '@/components/HomeBackground';
import Reveal from '@/components/landing/Reveal';
import HeroOrb from '@/components/landing/HeroOrb';
import ChatDemo from '@/components/landing/ChatDemo';
import IdentitySwap from '@/components/landing/IdentitySwap';
import { getCurrentUser } from '@/lib/auth';
import { inviteUrl } from '@/lib/discord';
import { env } from '@/lib/env';
import { publicServerCount } from '@/lib/publicStats';
import landing from '@/lib/landing';
import seo from '@/lib/seo';
import pricing from '@/lib/pricing';

// Title, description, canonical and sharing tags: lib/seo.js.
export const metadata = seo.pageMetadata('/');

// Dynamic: the page knows whether you are signed in and reads runtime config.
export const dynamic = 'force-dynamic';

// ZiGBoT's public listing in Discord's App Directory.
const APP_DIRECTORY_URL = 'https://discord.com/discovery/applications/1539530458390593576';
// The feature grid shows the first few cards; the rest open on demand.
const FEATURES_SHOWN = 6;

const ERRORS = {
    login_failed: 'Discord login did not complete. Please try again.',
    missing_code: 'The login link was incomplete. Please try again.',
    not_discord: 'Please sign in with a Discord account.'
};

function Mark({ value }) {
    if (value === true) return <><span aria-hidden="true" className="tick">✓</span><span className="sr-only">Included</span></>;
    if (value === false) return <><span aria-hidden="true" className="cross">—</span><span className="sr-only">Not included</span></>;
    return <span>{value}</span>;
}

export default async function Home({ searchParams }) {
    const params = await searchParams;
    const error = ERRORS[params?.error];

    let current = null;
    try {
        current = await getCurrentUser();
    } catch {
        current = null;
    }
    const meta = current?.user?.user_metadata || {};
    // The stored picture, not the login-time one: it is refreshed when it goes stale.
    let storedAvatar = null;
    if (current) {
        const { data } = await current.supabase.from('zb_profiles').select('avatar_url').eq('user_id', current.user.id).maybeSingle();
        storedAvatar = data?.avatar_url || null;
    }
    const profile = current ? { username: meta.full_name || meta.name || 'Signed in', avatar_url: storedAvatar || meta.avatar_url || null } : null;

    // Real config only: no invite link or price is shown if it isn't set.
    let invite = null;
    try {
        invite = inviteUrl();
    } catch {
        invite = null;
    }
    let prices = { monthly: '', yearly: '' };
    try {
        prices = env.premiumPriceLabels;
    } catch {
        prices = { monthly: '', yearly: '' };
    }
    const savings = pricing.yearlySavings(prices);
    const servers = await publicServerCount();
    const dashboardHref = current ? '/dashboard' : '/auth/login';
    const studioHref = current ? '/studio' : '/auth/login';
    // Custom bot identity is advertised only while it is on for every server
    // (no CUSTOM_IDENTITY_GUILDS pilot list), so "Premium servers can" is true.
    const { features, faq, ownerSteps, comparison } = landing.landingContent({
        customIdentity: env.customIdentityEnabled && env.customIdentityGuilds.length === 0
    });

    // Structured data only for what this page shows: the site's name, the
    // product (pitch and the feature cards below) and the FAQ rendered below.
    const featureCard = (feature, i) => (
        <Reveal as="article" key={feature.id} className="l-feature card" delay={(i % 3) * 80}>
            <div className="spread">
                <span className="l-feature-icon" aria-hidden="true">{feature.icon}</span>
                {feature.badge ? <span className={`pill ${feature.badge === landing.PREMIUM_LABEL ? 'pill-premium' : 'pill-optin'}`}>{feature.badge}</span> : null}
            </div>
            <h3>{feature.title}</h3>
            {feature.preview === 'identity' ? <IdentitySwap /> : null}
            <p className="muted small">{feature.text}</p>
            {feature.attribution ? <p className="small l-attribution">{feature.attribution}</p> : null}
        </Reveal>
    );

    const jsonLd = [
        seo.websiteJsonLd(),
        seo.softwareApplicationJsonLd({ description: landing.hero.pitch, features }),
        seo.faqJsonLd(faq)
    ];

    return (
        <div className="shell home landing">
            {jsonLd.map((data) => <script key={data['@type']} type="application/ld+json" dangerouslySetInnerHTML={{ __html: seo.jsonLdScript(data) }} />)}
            <HomeBackground />
            <div className="grain" aria-hidden="true" />
            <AdSense />
            <TopBar profile={profile} />

            {error ? <div className="notice" role="alert">{error}</div> : null}

            {/* 1. Hero */}
            <section className="l-hero" aria-labelledby="hero-title">
                <div className="l-hero-copy">
                    <p className="l-kicker">{landing.hero.kicker}</p>
                    <h1 id="hero-title" className="l-title">
                        {/* The space goes BETWEEN the inline-block words: a trailing
                            space inside an inline-block is dropped by the browser. */}
                        {landing.hero.headline.split(' ').map((word, i) => (
                            <Fragment key={`${word}-${i}`}>
                                {i > 0 ? ' ' : null}
                                <span className="l-word" style={{ '--i': i }}>{word}</span>
                            </Fragment>
                        ))}
                    </h1>
                    <p className="l-pitch">{landing.hero.pitch}</p>
                    <div className="row l-ctas">
                        {invite ? <a className="btn btn-primary btn-lg l-glow" href={invite} target="_blank" rel="noreferrer">➕ Add to Discord</a> : null}
                        <a className="btn btn-lg" href={APP_DIRECTORY_URL} target="_blank" rel="noreferrer">View in App Directory ↗</a>
                        <a className="btn btn-lg" href={studioHref}>Open ZiGBoT Studio →</a>
                        <Link className="btn btn-ghost btn-lg" href="/commands">See commands</Link>
                        {current ? <Link className="btn btn-ghost btn-lg" href="/dashboard">Open dashboard</Link> : null}
                    </div>
                    {servers > 0 ? <p className="l-servers"><strong>{servers.toLocaleString('en-IN')}</strong> {servers === 1 ? 'server uses' : 'servers use'} ZiGBoT</p> : null}
                    <p className="small muted">{landing.hero.note} 🔒</p>
                </div>
                <HeroOrb />
            </section>

            {/* 2. Product introduction */}
            <Reveal as="section" className="l-section l-intro" aria-labelledby="intro-title">
                <h2 id="intro-title" className="l-h2">{landing.intro.title}</h2>
                <p className="muted l-lead">{landing.intro.text}</p>
            </Reveal>

            {/* 3-5. ZiGBoT Studio: AI coding, visual workflows, prompt engineering */}
            <section className="l-section" aria-labelledby="studio-title">
                <Reveal>
                    <h2 id="studio-title" className="l-h2">ZiGBoT <span className="l-grad">Studio</span></h2>
                    <p className="muted l-lead">Build smarter. Automate faster. Your own bot, from first line to running on your server.</p>
                </Reveal>
                <div className="l-studio">
                    {landing.studioModes.map((mode, i) => (
                        <Reveal as="article" key={mode.id} id={`studio-${mode.id}`} className={`l-studio-card card${mode.status === 'coming_soon' ? ' is-soon' : ''}`} delay={i * 90}>
                            <div className="spread">
                                <span className="l-feature-icon" aria-hidden="true">{mode.icon}</span>
                                {mode.status === 'coming_soon' ? <span className="pill">Coming soon</span> : <span className="pill pill-ok">Available</span>}
                            </div>
                            <h3>{mode.title}</h3>
                            <p className="muted small">{mode.text}</p>
                            <ul className="l-studio-points">{mode.points.map((p) => <li key={p}>{p}</li>)}</ul>
                        </Reveal>
                    ))}
                </div>
                <div className="row">
                    <a className="btn btn-primary btn-lg l-glow" href={studioHref}>{current ? 'Open ZiGBoT Studio' : 'Sign in to open Studio'}</a>
                </div>
            </section>

            {/* 7. Discord integration: live chat demo */}
            <Reveal as="section" className="l-section" aria-labelledby="demo-title">
                <h2 id="demo-title" className="l-h2">See it in action</h2>
                <p className="muted l-lead">Four quick scenes. It&apos;s a demo, but every reply format is the real thing.</p>
                <ChatDemo scenes={landing.demoScenes} />
            </Reveal>

            {/* How the bot works in Discord */}
            <section className="l-section" aria-labelledby="how-title">
                <Reveal><h2 id="how-title" className="l-h2">How ZiGBoT works in Discord</h2></Reveal>
                <ol className="l-steps">
                    {landing.steps.map((step, i) => (
                        <Reveal as="li" key={step.title} className="l-step card" delay={i * 90}>
                            <span className="l-step-n" aria-hidden="true">{i + 1}</span>
                            <h3>{step.title}</h3>
                            <p className="muted small">{step.text}</p>
                        </Reveal>
                    ))}
                </ol>
            </section>

            {/* 4. Features */}
            <section className="l-section" aria-labelledby="features-title">
                <Reveal><h2 id="features-title" className="l-h2">The AI in your server</h2></Reveal>
                <div className="l-features">
                    {features.slice(0, FEATURES_SHOWN).map(featureCard)}
                </div>
                {features.length > FEATURES_SHOWN ? (
                    <details className="l-more">
                        <summary>Show all {features.length} features</summary>
                        <div className="l-features">{features.slice(FEATURES_SHOWN).map(featureCard)}</div>
                    </details>
                ) : null}
            </section>

            {/* 5. Why it's different */}
            <section className="l-section l-privacy" aria-labelledby="privacy-title">
                <Reveal>
                    <h2 id="privacy-title" className="l-h2 l-big">Your memory.<br /><span className="l-grad">Your rules.</span></h2>
                </Reveal>
                <div className="l-privacy-grid">
                    {landing.privacyPoints.map((point, i) => (
                        <Reveal key={point.title} className="l-privacy-point" delay={i * 70}>
                            <h3>{point.title}</h3>
                            <p className="muted small">{point.text}</p>
                        </Reveal>
                    ))}
                </div>
                <p className="small"><Link className="l-link" href="/privacy">Read exactly what we keep, and for how long →</Link></p>
            </section>

            {/* Premium */}
            <Reveal as="section" id="pricing" className="l-section" aria-labelledby="premium-title">
                <div className="l-premium">
                    <div className="l-premium-inner">
                        <h2 id="premium-title" className="l-h2">💎 ZiGBoT <span className="l-grad">Premium</span></h2>
                        <p className="muted">Free does the vibes. Premium turns the volume up — per server. Admins of a Premium server can also activate their ZiGBoT Studio automations.</p>
                        {prices.monthly || prices.yearly ? (
                            <p className="l-prices">
                                {prices.yearly ? <span><strong>{prices.yearly}</strong> yearly{savings ? <span className="pill pill-premium" style={{ marginLeft: 8 }}>Best value · {savings.text}</span> : null}</span> : null}
                                {prices.monthly && prices.yearly ? <span className="muted"> · or </span> : null}
                                {prices.monthly ? <span><strong>{prices.monthly}</strong> monthly</span> : null}
                            </p>
                        ) : null}
                        <table className="l-compare">
                            <caption className="sr-only">Free compared with Premium</caption>
                            <thead>
                                <tr><th scope="col">Feature</th><th scope="col">Free</th><th scope="col">Premium</th></tr>
                            </thead>
                            <tbody>
                                {comparison.map((row) => (
                                    <tr key={row.id} className={row.free === row.premium ? '' : 'l-compare-diff'}>
                                        <th scope="row">{row.label}</th>
                                        <td><Mark value={row.free} /></td>
                                        <td><Mark value={row.premium} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <div className="stack l-templates" aria-labelledby="templates-title">
                            <h3 id="templates-title">{landing.personaTemplates.title} <span className="pill pill-premium">{landing.PREMIUM_LABEL}</span></h3>
                            <p className="muted small">{landing.personaTemplates.text}</p>
                            <ul className="l-template-list">
                                {landing.personaTemplates.items.map((t) => (
                                    <li key={t.id}><span aria-hidden="true">{t.emoji}</span> <strong>{t.name}</strong> <span className="muted small">{t.description}</span></li>
                                ))}
                            </ul>
                        </div>
                        <div className="row">
                            <a className="btn btn-primary btn-lg l-glow" href={dashboardHref}>Get Premium</a>
                            <span className="small muted">{current ? 'Pick your server, then open the 💎 Premium tab.' : 'Sign in with Discord, pick your server, then open the 💎 Premium tab.'}</span>
                        </div>
                    </div>
                </div>
            </Reveal>

            {/* 9. Product updates */}
            <section className="l-section" aria-labelledby="updates-title">
                <Reveal><h2 id="updates-title" className="l-h2">What&apos;s new</h2></Reveal>
                <ol className="l-updates">
                    {landing.updates.map((u, i) => (
                        <Reveal as="li" key={u.title} className="l-update" delay={i * 70}>
                            <time className="pill" dateTime={u.date}>{new Date(`${u.date}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })}</time>
                            <div><h3>{u.title}</h3><p className="muted small">{u.text}</p></div>
                        </Reveal>
                    ))}
                </ol>
            </section>

            {/* For server owners */}
            <section className="l-section" aria-labelledby="owners-title">
                <Reveal><h2 id="owners-title" className="l-h2">For server owners</h2></Reveal>
                <ol className="l-owner-steps">
                    {ownerSteps.map((step, i) => (
                        <Reveal as="li" key={step.title} className="card" delay={i * 90}>
                            <span className="l-step-n" aria-hidden="true">{i + 1}</span>
                            <h3>{step.title}</h3>
                            <p className="muted small">{step.text}</p>
                            {step.link ? <a className="l-link small" href={dashboardHref}>{current ? step.link : 'Sign in to the dashboard'} →</a> : null}
                        </Reveal>
                    ))}
                </ol>
                <Reveal as="ul" className="l-controls">
                    {landing.ownerControls.map((item) => <li key={item}>✅ {item}</li>)}
                </Reveal>
                <div className="row">
                    <a className="btn btn-lg" href={dashboardHref}>{current ? 'Open dashboard' : 'Sign in with Discord'}</a>
                </div>
            </section>

            {/* 7. FAQ */}
            <section className="l-section" aria-labelledby="faq-title">
                <Reveal><h2 id="faq-title" className="l-h2">FAQ</h2></Reveal>
                <div className="l-faq">
                    {faq.map((item) => (
                        <details key={item.q} className="l-faq-item">
                            <summary>{item.q}</summary>
                            <p className="muted">{item.a}</p>
                        </details>
                    ))}
                </div>
            </section>

            {/* 8. Final CTA */}
            <Reveal as="section" className="l-section l-final" aria-labelledby="final-title">
                <h2 id="final-title" className="l-h2 l-big">Your server&apos;s <span className="l-grad">AI command center</span> is one click away.</h2>
                <div className="row l-ctas">
                    {invite ? <a className="btn btn-primary btn-lg l-glow" href={invite} target="_blank" rel="noreferrer">➕ Add to Discord</a> : null}
                    <a className="btn btn-lg" href={studioHref}>Open ZiGBoT Studio</a>
                    <a className="btn btn-lg" href={APP_DIRECTORY_URL} target="_blank" rel="noreferrer">View in App Directory ↗</a>
                    <Link className="btn btn-lg" href="/commands">See commands</Link>
                </div>
            </Reveal>
        </div>
    );
}
