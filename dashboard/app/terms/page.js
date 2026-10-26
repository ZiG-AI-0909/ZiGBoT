import Link from 'next/link';
import TopBar from '@/components/TopBar';
import { contactUrl } from '@/lib/discord';

export const metadata = {
    title: 'Terms of Service · ZiGBoT',
    description: 'The rules for using the ZiGBoT Discord bot and its dashboard.'
};

// Dynamic so the contact link uses the runtime env, like the other pages.
export const dynamic = 'force-dynamic';

const UPDATED = '24 October 2026';

export default function Terms() {
    const contact = contactUrl();
    return (
        <div className="shell">
            <TopBar />
            <article className="legal">
                <h1>Terms of Service</h1>
                <p className="muted small">Last updated: {UPDATED}</p>

                <p>
                    These terms cover the ZiGBoT Discord bot, its YouTube live-chat features, and this dashboard
                    (together, &quot;ZiGBoT&quot;). By adding ZiGBoT to a server, talking to it, or signing in here, you agree to them.
                    If you do not agree, do not use ZiGBoT.
                </p>

                <h2>1. Who can use ZiGBoT</h2>
                <p>
                    You must meet Discord&apos;s minimum age in your country (13 in most places) and follow the{' '}
                    <a href="https://discord.com/terms" target="_blank" rel="noreferrer">Discord Terms of Service</a> and{' '}
                    <a href="https://discord.com/guidelines" target="_blank" rel="noreferrer">Community Guidelines</a>.
                    ZiGBoT is an independent project and is not made, endorsed or supported by Discord, YouTube or Google.
                </p>

                <h2>2. What ZiGBoT does</h2>
                <p>
                    ZiGBoT replies to messages with an AI-generated personality, can join voice channels to listen and speak,
                    plays music, helps with moderation, and can chat in its owner&apos;s YouTube live streams.
                    Server admins configure how it behaves in their server through this dashboard.
                </p>

                <h2>3. AI replies</h2>
                <ul>
                    <li>Replies are written by AI models. They can be wrong, out of date, or unexpected. Do not rely on them for medical, legal, financial or safety decisions.</li>
                    <li>ZiGBoT has a joking, roasting style by design. Roasts are meant as banter, not as real statements about anyone.</li>
                    <li>Safety rules always apply on top of any server&apos;s custom settings, but no filter is perfect. If a reply is harmful, tell a server admin or contact us.</li>
                </ul>

                <h2>4. Server admins</h2>
                <p>
                    If you manage a server, you are responsible for how you set ZiGBoT up there: custom personality prompts,
                    rules, role behaviour, channels, voice and music settings, and any moderation actions you ask it to take.
                    You may only use the dashboard for servers where you have the Manage Server or Administrator permission.
                    Every save is re-checked against your live Discord permissions.
                </p>

                <h2>5. Acceptable use</h2>
                <p>You must not use ZiGBoT to:</p>
                <ul>
                    <li>harass, threaten, or target anyone, or produce hateful, sexual, or illegal content;</li>
                    <li>set up a custom prompt meant to get around its safety rules;</li>
                    <li>spam, overload, reverse-engineer, or attack the bot, the dashboard, or the services they rely on;</li>
                    <li>break Discord&apos;s or YouTube&apos;s rules, or the law where you live.</li>
                </ul>
                <h3>Custom bot identity</h3>
                <p>If your server gives ZiGBoT its own name, picture or bio (a Premium feature, when available), they must not:</p>
                <ul>
                    <li>pretend to be Discord, Discord staff, ZiGBoT staff, another well-known bot, or a real person;</li>
                    <li>try to hide that ZiGBoT is a bot or be used to trick members, for example to collect passwords, payments or personal details;</li>
                    <li>contain sexual, hateful, violent or illegal content, or anything you don&apos;t have the right to use;</li>
                    <li>contain links, invites or mentions in the bio.</li>
                </ul>
                <p>
                    Pictures are checked by us before they go live. We reserve the right to reject avatars that violate our guidelines or community standards. Discord always shows
                    ZiGBoT&apos;s APP tag. If Premium ends, or we turn the feature off for a server or an admin who breaks these rules,
                    ZiGBoT goes back to its default profile.
                </p>
                <p>We may limit, block, or remove ZiGBoT from any user or server that breaks these rules.</p>

                <h2>6. Premium</h2>
                <ul>
                    <li>Premium is bought per server and unlocks extra features for that server only. Prices are shown before you pay.</li>
                    <li>Payments are handled by Razorpay. Subscriptions renew automatically each billing period until cancelled.</li>
                    <li>You can cancel renewal from the server&apos;s Premium tab at any time. Premium stays active until the end of the period you already paid for.</li>
                    <li>Payments are not refundable except where the law requires it. If something went wrong with a payment, contact us and we will look at it.</li>
                    <li>We may change Premium features or prices. Price changes apply from your next billing period, and we will tell you first.</li>
                </ul>

                <h2>7. Availability</h2>
                <p>
                    ZiGBoT is provided &quot;as is&quot;. It runs on third-party services (AI, speech, hosting and database providers)
                    and may sometimes be slow, unavailable, or change without notice. We do not promise it will always work or keep every feature.
                </p>

                <h2>8. Liability</h2>
                <p>
                    As far as the law allows, we are not liable for indirect or consequential losses, for what other users
                    or server admins do with ZiGBoT, or for content the AI generates. Our total liability to you is limited
                    to what you paid us for Premium in the 3 months before the claim.
                </p>

                <h2>9. Ending use</h2>
                <p>
                    You can stop using ZiGBoT at any time: kick it from your server, sign out, or stop talking to it.
                    We may suspend or end access for anyone who breaks these terms.
                </p>

                <h2>10. Changes</h2>
                <p>
                    We may update these terms. The date at the top shows the latest version. If you keep using ZiGBoT after a change,
                    you accept the new terms.
                </p>

                <h2>11. Governing law</h2>
                <p>These terms are governed by the laws of India.</p>

                <h2>12. Contact</h2>
                <p>
                    Questions about these terms?{' '}
                    {contact ? <a href={contact} target="_blank" rel="noreferrer">Message ZiG on Discord</a> : 'Message ZiG on Discord'}.
                    See also the <Link href="/privacy">Privacy Policy</Link>.
                </p>
            </article>
        </div>
    );
}
