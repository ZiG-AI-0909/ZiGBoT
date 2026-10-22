import Link from 'next/link';
import TopBar from '@/components/TopBar';
import { contactUrl } from '@/lib/discord';

export const metadata = {
    title: 'Privacy Policy · ZiGBoT',
    description: 'What data ZiGBoT collects, why, who processes it, and how long it is kept.'
};

// Dynamic so the contact link uses the runtime env, like the other pages.
export const dynamic = 'force-dynamic';

const UPDATED = '22 October 2026';

export default function Privacy() {
    const contact = contactUrl();
    return (
        <div className="shell">
            <TopBar />
            <article className="legal">
                <h1>Privacy Policy</h1>
                <p className="muted small">Last updated: {UPDATED}</p>

                <p>
                    This policy explains what the ZiGBoT Discord bot, its YouTube live-chat features, and this dashboard
                    collect, why, and what happens to it. We do not sell your data and we do not show ads.
                </p>

                <h2>1. What we collect</h2>
                <h3>When you sign in to the dashboard</h3>
                <ul>
                    <li>Your Discord user ID, username, and avatar, from Discord login.</li>
                    <li>The list of servers you are in and whether you can manage them, so we only show servers you are allowed to configure.</li>
                    <li>A login session cookie. We use no analytics or advertising cookies.</li>
                </ul>

                <h3>When a server uses ZiGBoT</h3>
                <ul>
                    <li><strong>Server settings</strong> chosen by its admins (personality, rules, roles, channels, voice and music options), and a log of which admin changed what and when.</li>
                    <li><strong>Messages sent to ZiGBoT.</strong> When you mention or reply to ZiGBoT, it reads your message and a few recent messages in that channel so it can answer in context.</li>
                    <li><strong>Memories.</strong> Short notes from your conversations with ZiGBoT in that server, so it can remember what you talked about. They are deleted automatically after 30 days.</li>
                    <li><strong>Moderation and behaviour records</strong> for that server, such as warnings and signals of how members treat the bot, used to decide how it responds.</li>
                    <li><strong>Voice.</strong> When ZiGBoT is listening in a voice channel, what you say to it is sent for speech-to-text, and its replies are turned into speech. We do not keep the audio recordings.</li>
                    <li><strong>Music.</strong> Songs requested and the current playback status for the server.</li>
                </ul>

                <h3>In YouTube live chats</h3>
                <p>
                    On streams where ZiGBoT is active, it reads public live-chat messages and display names to reply, greet and moderate.
                    Short-lived records (for example who was already greeted, or a temporary ban) are deleted automatically within 1 to 3 days.
                </p>

                <h3>Premium payments</h3>
                <p>
                    Payments are processed by Razorpay. We receive and store the subscription ID, its status, and when the paid period ends.
                    We never see or store your card, UPI or bank details.
                </p>

                <h2>2. Why we use it</h2>
                <ul>
                    <li>To run ZiGBoT: reply, remember context, speak, play music, and moderate as each server has set it up.</li>
                    <li>To let admins manage only the servers they are allowed to manage.</li>
                    <li>To prevent abuse: rate limits, safety checks, and moderation.</li>
                    <li>To handle Premium subscriptions.</li>
                </ul>

                <h2>3. Who processes it</h2>
                <p>To work, ZiGBoT sends data to these services. Each only gets what it needs for its job:</p>
                <ul>
                    <li><strong>Discord</strong>: login, and the messages and voice ZiGBoT works with.</li>
                    <li><strong>NVIDIA</strong> and <strong>Groq</strong>: AI models that write replies and turn speech into text. They receive the message or speech being answered plus recent context.</li>
                    <li><strong>Sarvam AI</strong> and <strong>NVIDIA</strong>: turn ZiGBoT&apos;s replies into speech.</li>
                    <li><strong>Supabase</strong> and <strong>MongoDB</strong>: databases for settings, accounts, memories and records.</li>
                    <li><strong>Render</strong>: hosting.</li>
                    <li><strong>Razorpay</strong>: payments.</li>
                    <li><strong>YouTube (Google)</strong>: live-chat features.</li>
                </ul>
                <p>These services may process data outside your country. We do not share your data with anyone else unless the law requires it.</p>

                <h2>4. How long we keep it</h2>
                <ul>
                    <li>Memories: 30 days, then deleted automatically.</li>
                    <li>YouTube live-chat records: 1 to 3 days.</li>
                    <li>Voice audio: not stored.</li>
                    <li>Server settings and change logs: while ZiGBoT is used in that server, or until an admin resets them or asks us to delete them.</li>
                    <li>Dashboard account: until you ask us to delete it.</li>
                    <li>Payment records: as long as needed for accounting and the law.</li>
                </ul>

                <h2>5. Your choices</h2>
                <ul>
                    <li>Don&apos;t want ZiGBoT to read your message? Don&apos;t mention or reply to it.</li>
                    <li>Server admins can change or reset ZiGBoT&apos;s settings at any time, or remove it from the server.</li>
                    <li>You can ask us for a copy of your data, or to correct or delete it, by contacting us below.</li>
                </ul>

                <h2>6. Security</h2>
                <p>
                    Access to each server&apos;s settings is checked against live Discord permissions, and database access is restricted
                    per server. No system is perfectly secure, but we work to protect your data.
                </p>

                <h2>7. Children</h2>
                <p>
                    ZiGBoT is for people who meet Discord&apos;s minimum age. We do not knowingly collect data from younger children.
                    If you think we have, contact us and we will delete it.
                </p>

                <h2>8. Changes</h2>
                <p>We may update this policy. The date at the top shows the latest version.</p>

                <h2>9. Contact</h2>
                <p>
                    Privacy questions or data requests:{' '}
                    {contact ? <a href={contact} target="_blank" rel="noreferrer">message ZiG on Discord</a> : 'message ZiG on Discord'}.
                    See also the <Link href="/terms">Terms of Service</Link>.
                </p>
            </article>
        </div>
    );
}
