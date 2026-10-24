'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

// Everything a search can match for one command.
function searchText(command) {
    const parts = [command.name, command.description, command.about || ''];
    for (const sub of command.subcommands || []) parts.push(sub.name, sub.description, ...sub.options.map((o) => o.name));
    for (const option of command.options || []) parts.push(option.name, option.description);
    return parts.join(' ').toLowerCase();
}

function AdminBadge({ permission }) {
    return <span className="pill pill-admin">Admin only{permission ? ` · ${permission}` : ''}</span>;
}

// Same markup on server and client (no hydration mismatch); the clipboard is
// only touched on click.
function CopyButton({ text }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            className="btn btn-ghost cmd-copy"
            aria-label={`Copy ${text}`}
            onClick={() => {
                if (!navigator.clipboard) return;
                navigator.clipboard.writeText(text).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                }, () => {});
            }}
        >
            {copied ? 'Copied' : 'Copy'}
        </button>
    );
}

function Example({ text }) {
    return (
        <div className="cmd-example-row">
            <code className="cmd-example">{text}</code>
            <CopyButton text={text} />
        </div>
    );
}

function Options({ options }) {
    if (!options || options.length === 0) return null;
    return (
        <ul className="cmd-options">
            {options.map((option) => (
                <li key={option.name}>
                    <code>{option.name}</code>{' '}
                    <span className={`pill ${option.required ? 'pill-required' : ''}`}>{option.required ? 'required' : 'optional'}</span>{' '}
                    <span className="muted small">
                        {option.type} — {option.description}
                        {option.choices ? ` (${option.choices.join(', ')})` : ''}
                    </span>
                </li>
            ))}
        </ul>
    );
}

function CommandCard({ command }) {
    const admin = command.audience === 'admin';
    return (
        <article className="card cmd-card" id={`cmd-${command.name}`}>
            <div className="spread">
                <h3><code>/{command.name}</code></h3>
                {admin ? <AdminBadge permission={command.permission} /> : null}
            </div>
            <p>{command.description}</p>
            {admin ? (
                <p className="help">
                    Members won&apos;t see this command in Discord; people with the {command.permission} permission will. ZiGBoT checks
                    permissions again when it runs.
                </p>
            ) : null}
            {command.about ? (
                <p className="small cmd-about">
                    {command.about}{' '}
                    {command.privacyLink ? <Link href="/privacy">How we handle your data</Link> : null}
                </p>
            ) : null}
            {command.subcommands ? (
                <div className="cmd-subs">
                    {command.subcommands.map((sub) => (
                        <div className="cmd-sub" key={sub.name}>
                            <div className="spread">
                                <span className="cmd-sub-name"><code>{sub.name}</code> <span className="muted small">{sub.description}</span></span>
                                {sub.audience === 'admin' && !admin ? <AdminBadge /> : null}
                            </div>
                            {sub.note ? <p className="help">{sub.note}</p> : null}
                            <Options options={sub.options} />
                            <Example text={sub.example} />
                        </div>
                    ))}
                </div>
            ) : (
                <>
                    <Options options={command.options} />
                    <Example text={command.example} />
                </>
            )}
        </article>
    );
}

export default function CommandsBrowser({ categories }) {
    const [query, setQuery] = useState('');
    const needle = query.trim().toLowerCase();
    const visible = useMemo(() => categories
        .map((category) => ({ ...category, commands: category.commands.filter((command) => !needle || searchText(command).includes(needle)) }))
        .filter((category) => category.commands.length > 0), [categories, needle]);
    const count = visible.reduce((sum, category) => sum + category.commands.length, 0);

    return (
        <section className="stack" aria-label="Slash commands">
            <div className="field">
                <label htmlFor="cmd-search">Search slash commands</label>
                <input
                    id="cmd-search"
                    type="search"
                    placeholder="Try “play”, “memory”, “ban”…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    autoComplete="off"
                />
                <span className="help" aria-live="polite">{count} command{count === 1 ? '' : 's'}{needle ? ` matching “${query.trim()}”` : ''}</span>
            </div>

            {!needle ? (
                <nav className="row cmd-jump" aria-label="Categories">
                    {categories.map((category) => <a key={category.id} className="pill" href={`#${category.id}`}>{category.name}</a>)}
                </nav>
            ) : null}

            {visible.map((category) => (
                <section key={category.id} id={category.id} className="stack" aria-labelledby={`${category.id}-heading`}>
                    <h2 id={`${category.id}-heading`} className="cmd-category">{category.name}</h2>
                    <div className="cmd-grid">
                        {category.commands.map((command) => <CommandCard key={command.name} command={command} />)}
                    </div>
                </section>
            ))}

            {count === 0 ? <div className="card empty">No commands match “{query.trim()}”.</div> : null}
        </section>
    );
}
