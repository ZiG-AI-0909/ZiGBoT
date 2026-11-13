'use client';

import { useEffect, useState } from 'react';
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
    logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10'
};

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
            { href: base, label: 'Settings', icon: 'overview', exact: true },
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
            <main id="app-main" className="app-main">{children}</main>
        </div>
    );
}
