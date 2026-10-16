import 'server-only';
import { NextResponse } from 'next/server';
import shared from './shared';
import { env } from './env';

const { isSameOrigin } = shared;

export class HttpError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

export function json(data, status = 200) {
    return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Wrap a route handler: consistent JSON errors, no stack traces or secrets leaked. */
export function handler(fn) {
    return async (request, context) => {
        try {
            if (!['GET', 'HEAD'].includes(request.method)) {
                const ok = isSameOrigin({
                    origin: request.headers.get('origin'),
                    host: request.headers.get('x-forwarded-host') || request.headers.get('host'),
                    allowedOrigins: env.siteUrl ? [env.siteUrl] : []
                });
                if (!ok) throw new HttpError(403, 'Cross-origin request blocked.');
            }
            return await fn(request, context);
        } catch (error) {
            if (error instanceof HttpError) {
                return json({ error: error.message, ...error.extra }, error.status);
            }
            console.error('[dashboard api]', error?.message || error);
            const status = error?.status && error.status >= 400 && error.status < 600 ? error.status : 500;
            return json({ error: error?.publicMessage || 'Something went wrong on our side. Please try again.' }, status === 400 ? 400 : status >= 500 ? 502 : status);
        }
    };
}

export async function readJson(request, maxBytes = 64 * 1024) {
    const text = await request.text();
    if (text.length > maxBytes) throw new HttpError(413, 'Request body too large.');
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        throw new HttpError(400, 'Request body must be valid JSON.');
    }
}
