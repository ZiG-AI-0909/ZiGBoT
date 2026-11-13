// Section K: read-only dashboard staff access by role, without weakening admin access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const shared = require('../dashboard/lib/shared');

const G = '900000000000000001';
const OWNER = '100000000000000001';
const U = '100000000000000002';
const STAFF_ROLE = '400000000000000001';
const MANAGE_ROLE = '400000000000000002';
const MANAGE_GUILD = (1n << 5n).toString();
const guild = { id: G, owner_id: OWNER, roles: [{ id: G, permissions: '0' }, { id: STAFF_ROLE, permissions: '0' }, { id: MANAGE_ROLE, permissions: MANAGE_GUILD }] };
const member = (roles) => ({ user: { id: U }, roles });

test('admins keep full access exactly as before; staff roles give read-only access only', () => {
    const admin = shared.decideStaffAccess({ guild, member: member([MANAGE_ROLE]), discordUserId: U, staffRoleIds: [] });
    assert.deepEqual([admin.allowed, admin.staff, admin.readOnly], [true, false, false]);
    assert.deepEqual(admin.permissions, shared.decideGuildAccess({ guild, member: member([MANAGE_ROLE]), discordUserId: U }).permissions);

    const staff = shared.decideStaffAccess({ guild, member: member([STAFF_ROLE]), discordUserId: U, staffRoleIds: [STAFF_ROLE] });
    assert.deepEqual([staff.allowed, staff.staff, staff.readOnly, staff.code], [true, true, true, 'staff']);

    const nobody = shared.decideStaffAccess({ guild, member: member([]), discordUserId: U, staffRoleIds: [STAFF_ROLE] });
    assert.deepEqual([nobody.allowed, nobody.code], [false, 'missing_permission']);
});

test('staff roles never override identity, membership or bot-missing failures, and @everyone is never a staff role', () => {
    assert.equal(shared.decideStaffAccess({ guild, member: null, discordUserId: U, staffRoleIds: [STAFF_ROLE] }).code, 'not_member');
    assert.equal(shared.decideStaffAccess({ guild: null, member: member([STAFF_ROLE]), discordUserId: U, staffRoleIds: [STAFF_ROLE] }).code, 'bot_not_installed');
    assert.equal(shared.decideStaffAccess({ guild, member: { user: { id: '100000000000000003' }, roles: [STAFF_ROLE] }, discordUserId: U, staffRoleIds: [STAFF_ROLE] }).code, 'identity_mismatch');
    assert.equal(shared.decideStaffAccess({ guild, member: member([G]), discordUserId: U, staffRoleIds: [G] }).allowed, false, '@everyone (role id = guild id) cannot be used');
    assert.equal(shared.decideStaffAccess({ guild, member: member([STAFF_ROLE]), discordUserId: 'not-an-id', staffRoleIds: [STAFF_ROLE] }).allowed, false);
});

test('settings: no staff roles by default; staff roles must be real roles of the server', () => {
    assert.deepEqual(shared.defaultFeatureSettings().dashboard.staff_role_ids, []);
    const result = shared.validateFeatureSettings({ dashboard: { staff_role_ids: ['400000000000000099'] } }, { channelIds: new Set(), roleIds: new Set([STAFF_ROLE]), guildId: G });
    assert.ok(result.errors['dashboard.staff_role_ids']);
});

test('staff access never grants database write access, and every write route still requires an admin', () => {
    const auth = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'lib', 'auth.js'), 'utf8');
    const staffFn = auth.slice(auth.indexOf('export async function requireGuildStaff'));
    assert.doesNotMatch(staffFn, /zb_guild_admins/, 'no RLS grant row is written for staff');
    assert.match(staffFn, /return \{ \.\.\.\(await requireGuildAdmin\(guildId\)\), staff: false \}/, 'admins take the unchanged path');
    assert.match(staffFn, /error\.extra\?\.code !== 'missing_permission'\) throw error/, 'only a missing-permission denial can fall back to staff');

    // Only read-only GET routes may use the staff check.
    const apiRoot = path.join(__dirname, '..', 'dashboard', 'app', 'api');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === 'route.js' ? [path.join(dir, e.name)] : []));
    const staffRoutes = walk(apiRoot).filter((file) => fs.readFileSync(file, 'utf8').includes('requireGuildStaff'));
    assert.ok(staffRoutes.length >= 1);
    for (const file of staffRoutes) {
        const src = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(src, /export const (POST|PUT|PATCH|DELETE)/, `${path.relative(apiRoot, file)} must stay read-only`);
    }
    const config = fs.readFileSync(path.join(apiRoot, 'guilds', '[guildId]', 'config', 'route.js'), 'utf8');
    assert.match(config, /requireGuildAdmin\(guildId\)/);
    assert.doesNotMatch(config, /requireGuildStaff/);
});

test('the staff page renders read-only analytics only', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'app', 'dashboard', '[guildId]', 'staff', 'page.js'), 'utf8');
    assert.match(page, /await requireGuildStaff\(guildId\)/);
    assert.match(page, /<AnalyticsTab/);
    assert.doesNotMatch(page, /GuildEditor|fetch\(.*method/);
});
