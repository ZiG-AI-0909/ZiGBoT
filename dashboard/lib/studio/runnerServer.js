import 'server-only';
import { NextResponse } from 'next/server';
import { HttpError } from '@/lib/http';
import runner from '@/lib/studio/runner';
import { createServiceClient } from '@/lib/supabase/server';

const reply = (data, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Wrapper for the runner API (/api/runner/*). Called by the owner's runner
 * program, not by browsers: no cookies are used, so the browser same-origin
 * check does not apply; every call (except pairing) must carry a valid
 * runner token. Errors never echo secrets.
 */
export function runnerHandler(fn) {
    return async (request, context) => {
        try {
            return await fn(request, context);
        } catch (error) {
            if (error instanceof HttpError) return reply({ error: error.message, ...error.extra }, error.status);
            console.error('[runner api]', error?.message || error);
            return reply({ error: 'Something went wrong on our side. Try again shortly.' }, 502);
        }
    };
}

export { reply };

/** The paired runner for this request's bearer token, or 401. */
export async function requireRunner(request) {
    const token = runner.bearer(request.headers.get('authorization'));
    if (!token) throw new HttpError(401, 'Missing or invalid runner token. Pair the runner again.');
    const db = createServiceClient();
    const { data } = await db.from('studio_runners').select('id, project_id, owner_id, name, status, state').eq('token_hash', runner.hashRunnerToken(token)).maybeSingle();
    if (!data || data.status !== 'paired') throw new HttpError(401, 'This runner was removed or is not paired. Pair it again from the Deployments page.');
    return { db, runner: data };
}

export async function readBody(request, max = 64 * 1024) {
    const text = await request.text();
    if (text.length > max) throw new HttpError(413, 'Request body too large.');
    try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'Body must be JSON.'); }
}
