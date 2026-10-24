'use client';

import { useEffect, useRef, useState } from 'react';

// Scroll reveal with one IntersectionObserver per element. Content is fully
// visible in the server HTML (no JS, reduced motion, or already on screen):
// it is only hidden — via opacity/transform, never layout — when it starts
// below the fold, so nothing shifts and nothing is lost without JavaScript.
export default function Reveal({ as: Tag = 'div', className = '', delay = 0, style, children, ...rest }) {
    const ref = useRef(null);
    const [state, setState] = useState('static');

    useEffect(() => {
        const element = ref.current;
        if (!element || !('IntersectionObserver' in window)) return undefined;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
        const rect = element.getBoundingClientRect();
        if (rect.top < window.innerHeight && rect.bottom > 0) return undefined;
        setState('hidden');
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                setState('shown');
                observer.disconnect();
            }
        }, { rootMargin: '0px 0px -8% 0px' });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    return (
        <Tag ref={ref} className={`reveal reveal-${state} ${className}`.trim()} style={{ '--reveal-delay': `${delay}ms`, ...style }} {...rest}>
            {children}
        </Tag>
    );
}
