'use client';

import { usePathname } from 'next/navigation';

// Shown only inside the guarded /admin layout. Hiding links is not security:
// every /admin page and /api/admin route checks the Super Admin itself.
const LINKS = [
    { href: '/admin', label: 'Overview', icon: '📊' },
    { href: '/admin/users', label: 'Users', icon: '👤' },
    { href: '/admin/servers', label: 'Servers', icon: '🛰️' },
    { href: '/admin/premium', label: 'Premium & Revenue', icon: '💎' },
    { href: '/admin/feedback', label: 'Forms & Responses', icon: '📝' },
    { href: '/admin/security', label: 'Security', icon: '🛡️' },
    { href: '/admin/analytics', label: 'Analytics', icon: '📈' },
    { href: '/admin/settings', label: 'Settings & Audit', icon: '⚙️' }
];

export default function AdminNav() {
    const path = usePathname();
    const current = (href) => (href === '/admin' ? path === '/admin' : path === href || path.startsWith(`${href}/`));
    return (
        <nav className="adm-nav" aria-label="Admin sections">
            {LINKS.map((link) => (
                <a key={link.href} href={link.href} aria-current={current(link.href) ? 'page' : undefined}>
                    <span aria-hidden="true">{link.icon}</span>{link.label}
                </a>
            ))}
        </nav>
    );
}
