import TopBar from '@/components/TopBar';
import CommandsBrowser from '@/components/CommandsBrowser';
import catalog from '@/data/commands.json';

export const metadata = {
    title: 'Commands · ZiGBoT',
    description: 'Every ZiGBoT slash command for members and admins, with examples, plus what you can ask ZiGBoT by mentioning it.',
    robots: { index: true, follow: true }
};

// Dynamic so the top bar's contact link uses the runtime env, like the other
// pages. The command data itself is static: it is generated from the bot's
// real slash definitions by `npm run export-commands`.
export const dynamic = 'force-dynamic';

export default function Commands() {
    return (
        <div className="shell">
            <TopBar />
            <main className="commands stack">
                <header className="commands-head">
                    <h1>Commands</h1>
                    <p className="muted">
                        Everything you can do with ZiGBoT in a Discord server. Slash commands appear when you type <code>/</code>;
                        what each server allows can differ, because its admins choose ZiGBoT&apos;s settings.
                    </p>
                </header>

                <section className="card stack" aria-labelledby="talk-heading">
                    <div>
                        <h2 id="talk-heading">Talk to ZiGBoT</h2>
                        <p className="muted small">
                            Mention <code>@ZiGBoT</code> (or reply to one of its messages) in a channel where it is allowed to reply.
                        </p>
                    </div>
                    <ul className="talk-list">
                        {catalog.talk.map((item) => (
                            <li key={item.message}>
                                <code className="cmd-example">{item.message}</code>
                                <span className="muted small">{item.what}</span>
                            </li>
                        ))}
                    </ul>
                </section>

                <CommandsBrowser categories={catalog.categories} />
            </main>
        </div>
    );
}
