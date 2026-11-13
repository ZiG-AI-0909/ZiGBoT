'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Signed-in app frame: a collapsible sidebar (desktop) / slide-in drawer
 * (mobile) around the page. Pure navigation: every page still checks the
 * session and permissions itself on the server, so nothing here grants
 * access. The collapsed state is a per-browser convenience (localStorage,
 * failures ignored).
 */

const ICONS = {
    servers: 'M4 5h16v5H4zM4 14h16v5H4zM7 7.5h.01M7 16.5h.01',
    studio: 'M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 15.4 7.2 17.9l.9-5.4-3.9-3.8 5.4-.8z',
    plus: 'M12 5v14M5 12h14',
    market: 'M4 9l1.5-5h13L20 9M4 9v10h16V9M4 9h16M9 13h6',
    commands: 'M4 6h16M4 12h10M4 18h7',
    contact: 'M4 5h16v11H8l-4 4z',
    overview: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
    code: 'M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14',
    flow: 'M6 4a2 2 0 100 4 2 2 0 000-4zM18 16a2 2 0 100 4 2 2 0 000-4zM6 8v4a4 4 0 004 4h6',
    ai: 'M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2M12 9a3 3 0 110 6 3 3 0 010-6z',
    brush: 'M14 4l6 6-8 8H6v-6zM4 20h4',
    rocket: 'M12 15l-3-3c1-4 4-8 9-9-1 5-5 8-9 9M9 12l-4 1 2-4M12 15l-1 4 4-2',
    staff: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3 3-5 6-5s6 2 6 5M17 11a2.5 2.5 0 100-5M18 15c2 .5 3 2 3 4',
    collapse: 'M15 6l-6 6 6 6',
    menu: 'M4 6h16M4 12h16M4 18h16',
    close: 'M6 6l12 12M18 6L6 18',
    logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
    hash: 'M5 9h14M5 15h14M10 4L8 20M16 4l-2 16',
    tool: 'M14 6a4 4 0 00-5 5l-5 5 3 3 5-5a4 4 0 005-5l-2 2-3-1-1-3z',
    shield: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z',
    ticket: 'M4 7h16v3a2 2 0 000 4v3H4v-3a2 2 0 000-4zM14 7v10',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    music: 'M9 18V5l11-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM20 16a3 3 0 11-6 0 3 3 0 016 0z',
    mic: 'M12 3a3 3 0 013 3v6a3 3 0 01-6 0V6a3 3 0 013-3zM5 11a7 7 0 0014 0M12 18v3',
    card: 'M3 6h18v12H3zM7 10h4M7 14h6M15 10h2',
    play: 'M7 4l13 8-13 8z',
    gem: 'M6 4h12l3 5-9 11L3 9zM3 9h18M9 4l3 16 3-16',
    clock: 'M12 3a9 9 0 110 18 9 9 0 010-18zM12 7v5l3 2'
};

/**
 * In-page sections a page can put in the sidebar (e.g. the server settings
 * tabs). The page registers { label, items: [{ id, label, icon }], active,
 * onSelect }; the sidebar shows them as a group and calls onSelect.
 */
const SectionNavContext = createContext(null);

export function useSectionNav(config) {
    const set = useContext(SectionNavContext);
    const key = config ? `${config.label}|${config.active}|${config.items.map((i) => i.id).join(',')}` : '';
    useEffect(() => {
        if (!set) return undefined;
        set(config);
        return () => set(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [set, key]);
    return Boolean(set);
}

function Icon({ name }) {
    return (
        <svg className="nav-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={ICONS[name]} />
        </svg>
    );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNOWFLAKE = /^\d{17,20}$/;

/** Navigation groups for a path (pure; exported for tests). */
export function navFor(pathname) {
    const groups = [
        { label: 'Bot', items: [{ href: '/dashboard', label: 'Servers', icon: 'servers', exact: true }] },
        { label: 'Studio', items: [
            { href: '/studio', label: 'My bots', icon: 'studio', exact: true },
            { href: '/studio/new', label: 'Create new bot', icon: 'plus' },
            { href: '/studio/marketplace', label: 'Marketplace', icon: 'market' }
        ] }
    ];
    const parts = String(pathname || '').split('/').filter(Boolean);
    if (parts[0] === 'studio' && UUID.test(parts[1] || '')) {
        const base = `/studio/${parts[1]}`;
        groups.push({ label: 'This project', items: [
            { href: base, label: 'Overview', icon: 'overview', exact: true },
            { href: `${base}/code`, label: 'Code', icon: 'code' },
            { href: `${base}/builder`, label: 'Visual builder', icon: 'flow' },
            { href: `${base}/ai`, label: 'AI creator', icon: 'ai' },
            { href: `${base}/customize`, label: 'Customize', icon: 'brush' },
            { href: `${base}/deployments`, label: 'Deployments', icon: 'rocket' }
        ] });
    }
    if (parts[0] === 'dashboard' && SNOWFLAKE.test(parts[1] || '')) {
        const base = `/dashboard/${parts[1]}`;
        groups.push({ label: 'This server', items: [
            { href: base, label: 'Settings', icon: 'overview', exact: true, sectionsHere: true },
            { href: `${base}/staff`, label: 'Staff access', icon: 'staff' }
        ] });
    }
    groups.push({ label: 'Help', items: [{ href: '/commands', label: 'Commands', icon: 'commands' }] });
    return groups;
}

export const isActive = (pathname, item) => (item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`));

const STORAGE_KEY = 'zb-sidebar-collapsed';

export default function AppShell({ children, contactUrl }) {
    const pathname = usePathname() || '';
    const [collapsed, setCollapsed] = useState(false);
    const [open, setOpen] = useState(false);
    const [sections, setSections] = useState(null);

    useEffect(() => { try { setCollapsed(window.localStorage.getItem(STORAGE_KEY) === '1'); } catch { /* storage unavailable */ } }, []);
    useEffect(() => { setOpen(false); }, [pathname]);
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    function toggleCollapsed() {
        setCollapsed((c) => {
            try { window.localStorage.setItem(STORAGE_KEY, c ? '0' : '1'); } catch { /* ignore */ }
            return !c;
        });
    }

    const groups = navFor(pathname);
    return (
        <div className={`app-shell${collapsed ? ' is-collapsed' : ''}${open ? ' is-open' : ''}`}>
            <a className="skip-link" href="#app-main">Skip to content</a>
            <button type="button" className="app-menu-btn" aria-label="Open navigation" aria-expanded={open} aria-controls="app-sidebar" onClick={() => setOpen(true)}><Icon name="menu" /></button>
            {open ? <div className="app-backdrop" onClick={() => setOpen(false)} aria-hidden="true" /> : null}
            <aside id="app-sidebar" className="app-sidebar" aria-label="Main navigation">
                <div className="app-sidebar-head">
                    <Link href="/dashboard" className="brand app-brand" title="ZiGBoT">
                        <img className="brand-mark" src="/zigbot-144.webp" alt="" width="30" height="30" />
                        <span className="nav-label"><span className="zig">ZIG</span>BOT</span>
                    </Link>
                    <button type="button" className="app-close-btn" aria-label="Close navigation" onClick={() => setOpen(false)}><Icon name="close" /></button>
                </div>
                <nav className="app-nav">
                    {groups.map((g) => (
                        <div key={g.label} className="nav-group">
                            <div className="nav-group-label">{g.label}</div>
                            <ul>
                                {g.items.map((item) => {
                                    // The page's own sections replace its single "Settings" link.
                                    if (item.sectionsHere && sections && pathname === item.href) {
                                        return sections.items.map((s) => {
                                            const on = s.id === sections.active;
                                            return (
                                                <li key={`section-${s.id}`}>
                                                    <button type="button" className={`nav-link nav-button${on ? ' is-active' : ''}`} aria-current={on ? 'page' : undefined} title={collapsed ? s.label : undefined}
                                                        onClick={() => { sections.onSelect(s.id); setOpen(false); }}>
                                                        <Icon name={ICONS[s.icon] ? s.icon : 'overview'} /><span className="nav-label">{s.label}</span>
                                                    </button>
                                                </li>
                                            );
                                        });
                                    }
                                    const active = isActive(pathname, item);
                                    return (
                                        <li key={item.href}>
                                            <Link href={item.href} className={`nav-link${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} title={collapsed ? item.label : undefined}>
                                                <Icon name={item.icon} /><span className="nav-label">{item.label}</span>
                                            </Link>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    ))}
                </nav>
                <div className="app-sidebar-foot">
                    {contactUrl ? <a className="nav-link" href={contactUrl} target="_blank" rel="noreferrer" title={collapsed ? 'Contact' : undefined}><Icon name="contact" /><span className="nav-label">Contact</span></a> : null}
                    <form action="/auth/logout" method="post">
                        <button className="nav-link nav-button" type="submit" title={collapsed ? 'Log out' : undefined}><Icon name="logout" /><span className="nav-label">Log out</span></button>
                    </form>
                    <button type="button" className="nav-link nav-button app-collapse-btn" onClick={toggleCollapsed} aria-pressed={collapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
                        <Icon name="collapse" /><span className="nav-label">Collapse</span>
                    </button>
                </div>
            </aside>
            <main id="app-main" className={`app-main${sections ? ' has-section-nav' : ''}`}>
                <SectionNavContext.Provider value={setSections}>{children}</SectionNavContext.Provider>
            </main>
        </div>
    );
}
