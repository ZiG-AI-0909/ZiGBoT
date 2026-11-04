'use client';

import { useEffect, useRef, useState } from 'react';

// The signed-in member's Discord picture. The stored URL goes stale when they
// change it on Discord, so a failed or missing picture asks the server for the
// current one, once. If that fails too, their initial is shown instead.
export default function UserAvatar({ src, name }) {
    const [url, setUrl] = useState(src || null);
    const [failed, setFailed] = useState(false);
    const repaired = useRef(false);
    const image = useRef(null);

    async function repair() {
        if (repaired.current) {
            setFailed(true);
            return;
        }
        repaired.current = true;
        try {
            const response = await fetch('/api/profile/avatar', { method: 'POST' });
            const body = response.ok ? await response.json() : null;
            if (body?.url && body.url !== url) setUrl(body.url);
            else setFailed(true);
        } catch {
            setFailed(true);
        }
    }

    // A picture that failed before hydration never fires onError here.
    useEffect(() => {
        if (!url || (image.current?.complete && image.current.naturalWidth === 0)) repair();
    }, []);

    if (failed || !url) return <span className="avatar avatar-initial" aria-hidden="true">{String(name || '?').trim().charAt(0).toUpperCase() || '?'}</span>;
    return <img ref={image} className="avatar" src={url} alt="" width="28" height="28" onError={repair} />;
}
