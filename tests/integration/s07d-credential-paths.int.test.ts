// tests/integration/s07d-credential-paths.int.test.ts
//
// S-07d (migration 935): no app role may write a member's role, the AFS portal
// tables, the AR portal logins or share links any more; the code makes those
// writes on the migration_admin pool. This proves each legitimate path still
// works end to end through its real route, on the production logins (s07b
// helpers), and that the rules the member guard enforced for app_user still
// hold on migration_admin, which the guard does not judge. Only outbound email
// is stubbed. Audit sessions, capture inboxes and bank feeds:
// s07d-credential-paths.capture.int.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import companyUsersRoute from '../../pages/api/accounting/company-users';
import contactsRoute from '../../pages/api/accounting/afs/portal-contacts';
import contactRoute from '../../pages/api/accounting/afs/portal-contacts/[contactId]';
import portalAuthRoute from '../../pages/api/accounting/portal/auth';
import portalVerifyRoute from '../../pages/api/accounting/portal/auth/verify';
import arPortalAuthRoute from '../../pages/api/portal/auth';
import mergeRoute from '../../pages/api/accounting/customer-merge';
import shareLinksRoute from '../../pages/api/accounting/share/links';
import shareRevokeRoute from '../../pages/api/accounting/share/links/[id]/revoke';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { resolveShareLink } from '@/modules/accounting/services/share/shareResolver';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';
import { callPublic, poll } from './s07c-credential-paths.helpers';

const mail = vi.hoisted(() => ({ links: [] as Array<{ email: string; url: string }> }));
vi.mock('@/modules/accounting/services/afs/portalNotificationService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyMagicLinkRequested: vi.fn(async (to: { email: string }, links: Array<{ url: string }>) => {
    for (const l of links) mail.links.push({ email: to.email, url: l.url });
  }),
}));

const ids = newIds();
// me is an admin of company, owner its only owner.
const { me, owner, invitee, company } = ids;
const contactEmail = `${crypto.randomUUID()}@portal.test.local`;
const customers = [crypto.randomUUID(), crypto.randomUUID()];
const arEmail = `${crypto.randomUUID()}@ar.test.local`;

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('PORTAL_JWT_SECRET', 's07d-portal-jwt-secret-0123456789abcdef');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.s07d.test');
  await fixture.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [company, invitee]);
  for (const [i, id] of customers.entries()) {
    await fixture.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)`, [id, company, `S07d customer ${i}`]);
  }
  await fixture.query(`INSERT INTO portal_access (client_id, email, password_hash, name) VALUES ($1, $2, $3, 'S07d')`,
    [customers[0], arEmail, await bcrypt.hash('s07d-ar-password', 4)]);
}, 60000);
afterAll(async () => {
  await fixture.query('DELETE FROM portal_access WHERE client_id = ANY($1::uuid[])', [customers]);
  for (const t of ['share_link_views', 'share_links', 'portal_magic_links', 'portal_contacts']) {
    await fixture.query(`DELETE FROM ${t} WHERE company_id = $1`, [company]);
  }
  await fixture.query('DELETE FROM customer_merges WHERE company_id = $1', [company]).catch(() => undefined);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]);
});
beforeEach(() => fixture.query(`DELETE FROM rate_limit_counters WHERE key LIKE ANY ($1)`,
  [['afs-portal-magic-link:%', 'portal-auth:%', 'share%']]));

const role = async (userId: string) => (await fixture.query(
  'SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [company, userId])).rows[0]?.role as string | undefined;
const setRole = (sub: string, userId: string, r: string) =>
  callRoute(companyUsersRoute, { sub, method: 'PUT', companyId: company, body: { userId, role: r } });

describe('S-07d: a member\'s role, on migration_admin', () => {
  it('an admin changes a viewer\'s role; the change log names the admin', async () => {
    expect((await setRole(me, invitee, 'manager')).status).toBe(200);
    expect(await role(invitee)).toBe('manager');
    const log = await fixture.query(`SELECT actor, channel, login_role FROM entity_changes WHERE entity_type = 'company_user'
      AND company_id = $1 AND op = 'update' ORDER BY seq DESC LIMIT 1`, [company]);
    expect(log.rows[0]).toEqual({ actor: me, channel: 'session', login_role: 'migration_admin' });
  });

  it('an admin cannot grant owner (RC003) or demote an owner (RC010): 403, nothing written', async () => {
    expect((await setRole(me, invitee, 'owner')).status).toBe(403);
    expect((await setRole(me, owner, 'viewer')).status).toBe(403);
    expect(await role(invitee)).toBe('manager');
    expect(await role(owner)).toBe('owner');
  });

  it('a manager cannot change roles, even past the route\'s gate (RC001)', async () => {
    const { updateCompanyUserRole, MemberRoleForbiddenError } = await import('@/modules/accounting/services/core/userAccessService');
    await expect(updateCompanyUserRole(company, me, 'viewer', invitee)).rejects.toBeInstanceOf(MemberRoleForbiddenError);
    expect(await role(me)).toBe('admin');
  });

  it('the only owner is never demoted (RC005); an owner promotes, then demotes another owner', async () => {
    expect((await setRole(owner, owner, 'admin')).status).toBe(400);
    expect((await setRole(owner, me, 'owner')).status).toBe(200);
    expect(await role(me)).toBe('owner');
    expect((await setRole(owner, me, 'admin')).status).toBe(200);
    expect(await role(me)).toBe('admin');
    expect(await role(owner)).toBe('owner');
  });

  it('a non-member target is refused, not silently ignored', async () => {
    expect((await setRole(owner, crypto.randomUUID(), 'viewer')).status).toBe(400);
  });
});

describe('S-07d: the AFS portal, on migration_admin', () => {
  let contactId = '';
  it('an admin adds, edits and removes a portal contact', async () => {
    const created = await callRoute(contactsRoute, { sub: me, method: 'POST', companyId: company,
      body: { name: 'S07d Director', email: contactEmail, role: 'director' } });
    expect(created.status).toBe(201);
    contactId = ((created.body as { data: { contact: { id: string } } }).data.contact.id);
    const edited = await callRoute(contactRoute, { sub: me, method: 'PUT', companyId: company, query: { contactId },
      body: { role: 'cfo' } });
    expect(edited.status).toBe(200);
    expect((await callRoute(contactRoute, { sub: me, method: 'PUT', companyId: company, query: { contactId: crypto.randomUUID() },
      body: { role: 'cfo' } })).status).toBe(404);
  });

  it('the contact asks for a link, and the emailed link signs them in once', async () => {
    expect((await callPublic(portalAuthRoute, { body: { email: contactEmail } })).status).toBe(200);
    const link = await poll(async () => mail.links.find((l) => l.email === contactEmail));
    expect(link).toBeTruthy();
    const token = new URL(link!.url).searchParams.get('token')!;
    const verify = () => callPublic(portalVerifyRoute, { method: 'GET', query: { token } });
    const first = await verify();
    expect(first.status).toBe(302);
    expect(String(first.headers.get('location'))).toContain('/accounting/afs/portal/dashboard');
    expect(String(first.headers.get('set-cookie'))).toContain('portal_session=');
    expect(String((await verify()).headers.get('location'))).toContain('error=expired');
  });

  it('a removed contact asks and receives nothing', async () => {
    expect((await callRoute(contactRoute, { sub: me, method: 'DELETE', companyId: company, query: { contactId } })).status).toBe(204);
    const before = mail.links.length;
    await callPublic(portalAuthRoute, { body: { email: contactEmail } });
    await new Promise((r) => setTimeout(r, 500));
    expect(mail.links.length).toBe(before);
  });
});

describe('S-07d: the AR portal, on migration_admin', () => {
  it('a customer signs in with their password; a wrong one is refused', async () => {
    expect((await callPublic(arPortalAuthRoute, { body: { email: arEmail, password: 'wrong' } })).status).toBe(401);
    const ok = await callPublic(arPortalAuthRoute, { body: { email: arEmail, password: 's07d-ar-password' } });
    expect(ok.status).toBe(200);
    const stamped = await fixture.query('SELECT last_login_at FROM portal_access WHERE email = $1', [arEmail]);
    expect(stamped.rows[0]?.last_login_at).toBeTruthy();
  });

  it('merging the customer away removes its portal login', async () => {
    const r = await callRoute(mergeRoute, { sub: me, method: 'POST', companyId: company,
      body: { source_id: customers[0], target_id: customers[1] } });
    expect(r.status).toBe(200);
    expect((await fixture.query('SELECT 1 FROM portal_access WHERE email = $1', [arEmail])).rowCount).toBe(0);
  });
});

describe('S-07d: share links, on migration_admin', () => {
  it('created, viewed and revoked through the routes', async () => {
    const created = await callRoute(shareLinksRoute, { sub: me, method: 'POST', companyId: company,
      body: { params: { type: 'management', from: '2026-01-01', to: '2026-01-31' }, ttlDays: 7 } });
    expect(created.status).toBe(200);
    const { token, link } = (created.body as { data: { token: string; link: { id: string } } }).data;
    const ctx = { ip: '127.0.0.1', userAgent: 's07d' };
    expect((await resolveShareLink(token, ctx)).status).toBe('ok');
    const revoked = await callRoute(shareRevokeRoute, { sub: me, method: 'POST', companyId: company, query: { id: link.id } });
    expect(revoked.status).toBe(200);
    expect((await resolveShareLink(token, ctx)).status).toBe('revoked');
  });
});
