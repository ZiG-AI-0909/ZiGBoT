import { handler, json, readJson, HttpError } from '@/lib/http';
import market from '@/lib/studio/marketplace';
import { createServiceClient } from '@/lib/supabase/server';
import { isSuperAdmin } from '@/lib/admin';
import { requireStudioUser, getOwnedProject, getPlan } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

const LIST = 'id, owner_id, name, description, framework, status, installs, scan, created_at';

// GET: published templates, the user's own, plan + limits, billing status.
// Super Admins also get the review queue.
export const GET = handler(async () => {
    const current = await requireStudioUser();
    const { supabase, ownerId } = current;
    const { data, error } = await supabase.from('studio_templates').select(LIST).order('created_at', { ascending: false }).limit(200);
    if (error) throw new HttpError(503, 'Marketplace storage is not set up yet: run the newest files in supabase/migrations.');
    const plan = await getPlan(supabase, ownerId);
    let review = [];
    if (isSuperAdmin(current.discordId)) {
        const { data: queue } = await createServiceClient().from('studio_templates').select(LIST).eq('status', 'pending_review').order('created_at').limit(100);
        review = (queue || []).map((t) => ({ ...market.publicTemplate(t, null), scan: t.scan }));
    }
    return json({
        published: (data || []).filter((t) => t.status === 'published').map((t) => market.publicTemplate(t, ownerId)),
        mine: (data || []).filter((t) => t.owner_id === ownerId).map((t) => market.publicTemplate(t, ownerId)),
        review,
        plan, limits: market.limitsFor(plan), billing: market.BILLING
    });
});

// POST { projectId, name, description }: publish one of the user's projects
// as a template. Static scan first: credentials block it; everything else
// goes to "pending review". Written with the service role so the status
// cannot be set by the browser.
export const POST = handler(async (request) => {
    const { supabase, ownerId } = await requireStudioUser();
    const body = await readJson(request, 8192);
    const project = await getOwnedProject(supabase, ownerId, body?.projectId);
    const listing = market.validateListing(body);
    if (listing.errors) throw new HttpError(422, 'Some fields need fixing.', { fieldErrors: listing.errors });
    const plan = await getPlan(supabase, ownerId);
    const db = createServiceClient();
    const { count } = await db.from('studio_templates').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId).in('status', ['pending_review', 'published']);
    if ((count || 0) >= market.limitsFor(plan).templates) throw new HttpError(403, `Your plan allows ${market.limitsFor(plan).templates} published template(s).`, { code: 'plan_limit' });

    const { data: rows, error } = await supabase.from('studio_project_files').select('path, content').eq('project_id', project.id).eq('owner_id', ownerId).limit(1000);
    if (error) throw new Error('File read failed.');
    const packed = market.templateFiles(rows || []);
    if (packed.error) throw new HttpError(422, packed.error);
    const scan = market.scanFiles(packed.files);
    if (scan.blocked) throw new HttpError(422, 'This project contains a credential (token, key or webhook). Remove it before publishing.', { findings: scan.findings.filter((f) => f.severity === 'block').map(({ path, line, rule }) => ({ path, line, rule })) });

    const { data, error: insertError } = await db.from('studio_templates').insert({
        owner_id: ownerId, source_project_id: project.id, ...listing.value, framework: project.framework, base_template: project.template,
        files: packed.files, scan: { findings: scan.findings, scannedAt: new Date().toISOString() }, status: 'pending_review'
    }).select(LIST).single();
    if (insertError) throw new Error('Publish failed.');
    return json({ template: market.publicTemplate(data, ownerId) }, 201);
});
