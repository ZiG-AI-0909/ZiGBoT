# ZiGBoT Studio: feature matrix

Status: WORKING (a named test exercises it), PARTIAL, MISSING, NOT AVAILABLE (needs infrastructure that does not exist), BLOCKED (external reason). Updated at every phase checkpoint.

## Phase 1: Audit and foundation

| Feature | Status | Proof |
|---|---|---|
| Repository audit | WORKING | `docs/ZIGBOT_STUDIO_AUDIT.md` |
| Reuse existing Discord login | WORKING | Studio routes call `requireStudioUser()` → `requireUser()` (`dashboard/lib/studio/server.js`); test `every Studio API route uses the existing login and filters by the session owner` |
| Project storage with owner-only access | WORKING | `supabase/migrations/20261115000000_studio_projects.sql` (RLS `owner_id = auth.uid()`); tests `IDOR: user B cannot read, change or delete user A's project; anon sees nothing`, `a user cannot move their project to someone else` |
| Create project | WORKING | `POST /api/studio/projects`; owner from the session only; test `new project: valid wizard input becomes a clean row; owner_id never comes from the request` |
| Rename / archive / unarchive | WORKING | `PATCH /api/studio/projects/[id]` (only name, description, status, visibility); test `patches: only name, description, status and visibility can change` |
| Duplicate | WORKING | `POST /api/studio/projects/[id]/duplicate`, counts towards the limit; test `duplicate names: "copy", then numbered, within 40 characters` |
| Delete with confirmation | WORKING | `DELETE /api/studio/projects/[id]` requires the exact project name; UI asks for it (`components/studio/StudioProjects.js`) |
| 5-step creation wizard | WORKING | `components/studio/StudioWizard.js` (identity, framework, template, Discord application guidance, create), same validation as the server; test `the wizard has the 5 steps; frameworks and templates are the ones with generators`. Built (`next build`), not browser-tested |
| Free plan: 3 projects, enforced on the backend | WORKING | Database trigger with a per-owner advisory lock (race-safe), archived projects count; users cannot change their plan; test `plans: free allows 3 projects (archived ones count), ...` |
| Search and filter (My bots) | WORKING | Client-side search and active/archived filter in `StudioProjects.js` (not browser-tested) |
| Separation from ZiGBoT | WORKING | test `ZiGBoT and Studio stay separate: nothing in src/ imports Studio code` |
| Payments for plans | BLOCKED | No Studio payment provider; plans are flags set by the service role only |

## Later phases

| Phase | Status |
|---|---|
| 2 Framework generators, templates, zip export | MISSING |
| 3 Customization, token validation | MISSING |
| 4 Code Studio | MISSING |
| 5 Visual builder | MISSING |
| 6 AI bot creator | MISSING |
| 7 Deployment foundation | MISSING (real hosting NOT AVAILABLE) |
| 8 Marketplace and billing | MISSING (payments BLOCKED) |
