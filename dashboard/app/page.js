import { Fragment } from 'react';
import Link from 'next/link';
import './landing.css';
import TopBar from '@/components/TopBar';
import HomeBackground from '@/components/HomeBackground';
import Reveal from '@/components/landing/Reveal';
import HeroOrb from '@/components/landing/HeroOrb';
import ChatDemo from '@/components/landing/ChatDemo';
import IdentitySwap from '@/components/landing/IdentitySwap';
import { getCurrentUser } from '@/lib/auth';
import { inviteUrl, contactUrl } from '@/lib/discord';
import { env } from '@/lib/env';
import landing from '@/lib/landing';

export const metadata = {
    title: 'ZiGBoT · the Discord bot with a personality and memory you control',
    description: 'ZiGBoT chats, roasts (nicely), plays music and helps moderate your Discord server — and lets you see, fix and delete anything it remembers about you.',
    robots: { index: true, follow: true }
};

// Dynamic: the page knows whether you are signed in and reads runtime config.
export const dynamic = 'force-dynamic';

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
    const profile = current ? { username: meta.full_name || meta.name || 'Signed in', avatar_url: meta.avatar_url || null } : null;

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
    const contact = contactUrl();
    const dashboardHref = current ? '/dashboard' : '/auth/login';
    // Custom bot identity is advertised only while it is on for every server
    // (no CUSTOM_IDENTITY_GUILDS pilot list), so "Premium servers can" is true.
    const { features, faq, ownerSteps, comparison } = landing.landingContent({
        customIdentity: env.customIdentityEnabled && env.customIdentityGuilds.length === 0
    });

    return (
        <div className="shell home landing">
            <HomeBackground />
            <div className="grain" aria-hidden="true" />
            <TopBar profile={profile} />

            {error ? <div className="notice" role="alert">{error}</div> : null}

            {/* 1. Hero */}
            <section className="l-hero" aria-labelledby="hero-title">
                <div className="l-hero-copy">
                    <p className="l-kicker">Discord bot · chat · memory · music · moderation</p>
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
                        <Link className="btn btn-lg" href="/commands">See commands →</Link>
                        {current ? <Link className="btn btn-ghost btn-lg" href="/dashboard">Open dashboard</Link> : null}
                    </div>
                    <p className="small muted">{landing.hero.note} 🔒</p>
                </div>
                <HeroOrb />
            </section>

            {/* 2. Live chat demo */}
            <Reveal as="section" className="l-section" aria-labelledby="demo-title">
                <h2 id="demo-title" className="l-h2">See it in action</h2>
                <p className="muted l-lead">Four quick scenes. It&apos;s a demo, but every reply format is the real thing.</p>
                <ChatDemo scenes={landing.demoScenes} />
            </Reveal>

            {/* 3. How it works */}
            <section className="l-section" aria-labelledby="how-title">
                <Reveal><h2 id="how-title" className="l-h2">How ZiGBoT works</h2></Reveal>
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
                <Reveal><h2 id="features-title" className="l-h2">What it does</h2></Reveal>
                <div className="l-features">
                    {features.map((feature, i) => (
                        <Reveal as="article" key={feature.id} className="l-feature card" delay={(i % 3) * 80}>
                            <div className="spread">
                                <span className="l-feature-icon" aria-hidden="true">{feature.icon}</span>
                                {feature.badge ? <span className={`pill ${feature.badge === landing.PREMIUM_LABEL ? 'pill-premium' : 'pill-optin'}`}>{feature.badge}</span> : null}
                            </div>
                            <h3>{feature.title}</h3>
                            {feature.preview === 'identity' ? <IdentitySwap /> : null}
                            <p className="muted small">{feature.text}</p>
                        </Reveal>
                    ))}
                </div>
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
            <Reveal as="section" className="l-section" aria-labelledby="premium-title">
                <div className="l-premium">
                    <div className="l-premium-inner">
                        <h2 id="premium-title" className="l-h2">💎 ZiGBoT <span className="l-grad">Premium</span></h2>
                        <p className="muted">Free does the vibes. Premium turns the volume up — per server.</p>
                        {prices.monthly || prices.yearly ? (
                            <p className="l-prices">
                                {prices.monthly ? <span><strong>{prices.monthly}</strong> monthly</span> : null}
                                {prices.monthly && prices.yearly ? <span className="muted"> · </span> : null}
                                {prices.yearly ? <span><strong>{prices.yearly}</strong> yearly</span> : null}
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
                        <div className="row">
                            <a className="btn btn-primary btn-lg l-glow" href={dashboardHref}>Get Premium</a>
                            <span className="small muted">{current ? 'Pick your server, then open the 💎 Premium tab.' : 'Sign in with Discord, pick your server, then open the 💎 Premium tab.'}</span>
                        </div>
                    </div>
                </div>
            </Reveal>

            {/* 6. For server owners */}
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
                <h2 id="final-title" className="l-h2 l-big">Ready to give your server <span className="l-grad">a main character?</span></h2>
                <div className="row l-ctas">
                    {invite ? <a className="btn btn-primary btn-lg l-glow" href={invite} target="_blank" rel="noreferrer">➕ Add to Discord</a> : null}
                    <Link className="btn btn-lg" href="/commands">See commands</Link>
                    {contact ? <a className="btn btn-ghost btn-lg" href={contact} target="_blank" rel="noreferrer">💬 Contact</a> : null}
                </div>
            </Reveal>
        </div>
    );
}
