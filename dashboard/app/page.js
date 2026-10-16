import { redirect } from 'next/navigation';
import TopBar from '@/components/TopBar';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const ERRORS = {
    login_failed: 'Discord login did not complete. Please try again.',
    missing_code: 'The login link was incomplete. Please try again.',
    not_discord: 'Please sign in with a Discord account.'
};

export default async function Home({ searchParams }) {
    const params = await searchParams;
    let current = null;
    try {
        current = await getCurrentUser();
    } catch {
        current = null;
    }
    if (current) redirect('/dashboard');
    const error = ERRORS[params?.error];

    return (
        <div className="shell">
            <TopBar />
            <section className="hero">
                <img className="hero-avatar" src="/zigbot.png" alt="ZiGBoT" width="120" height="120" />
                <p className="hero-tagline">Auto replies. Gen Z vibes. Zero drama. <em>Max roast.</em></p>
                <h1>Make <span className="zig">ZiG</span>BoT yours, server by server.</h1>
                <p className="muted">Sign in with Discord to configure ZiGBoT in the servers you manage. Each server gets its own personality, rules, role behaviour and channels — changes in one server never touch another.</p>
                {error ? <div className="notice" role="alert">{error}</div> : null}
                <div className="row">
                    <a className="btn btn-primary btn-lg" href="/auth/login">Sign in with Discord</a>
                </div>
                <ul className="small">
                    <li>You only see servers where you have Manage Server or Administrator.</li>
                    <li>Every save is re-checked against your live Discord permissions.</li>
                    <li>ZiGBoT&apos;s safety rules always apply on top of your custom prompt.</li>
                </ul>
            </section>
        </div>
    );
}
