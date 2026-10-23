/**
 * S-04 follow-on (blind review finding 3): createInvitation grants owner two
 * ways — it INSERTs an existing user straight into company_users at the
 * invited role, or writes an owner invitation. Like updateCompanyUserRole's
 * promotion, it must take the owner lock and read the inviter's role live
 * after it, not trust the request's role.
 *
 * POST /api/accounting/company-invitations runs the REAL userInvitationService
 * here; only `sql`, the rate limit and the mailer are replaced. The real-PG
 * proof (incl. an inviter being demoted at that moment) is
 * tests/integration/s04-owner-grant-invitations.int.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({ statements: [] as string[], inviterRole: 'owner', userExists: true }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn((strings: TemplateStringsArray) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    h.statements.push(text);
    if (/^SELECT role FROM company_users/.test(text)) return Promise.resolve([{ role: h.inviterRole }]);
    if (/^SELECT id FROM users/.test(text)) return Promise.resolve(h.userExists ? [{ id: 'existing-user' }] : []);
    if (/^INSERT INTO company_invitations/.test(text)) return Promise.resolve([{ id: 'inv-1', role: 'owner' }]);
    return Promise.resolve([]);
  }),
}));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/rateLimit', () => ({ checkSendRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({
  sendInviteEmail: vi.fn(async () => ({ success: true })),
}));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import handler from '../../../pages/api/accounting/company-invitations';
import { createInvitation, OwnerProtectedError } from '@/modules/accounting/services/core/userAccessService';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
const COMPANY_ID = '11111111-1111-4111-9111-111111111111';

function post(companyRole: string, role: string) {
  const req = {
    method: 'POST', query: {}, body: { email: 'invitee@co.test', role }, headers: {},
    companyId: COMPANY_ID, companyRole, user: { id: 'inviter', email: 'inviter@co.test' },
  } as unknown as NextApiRequest;
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() } as unknown as NextApiResponse;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return { promise: (handler as Handler)(req, res), res };
}

const writes = () => h.statements.filter((s) => /^INSERT/.test(s));
const statusOf = (res: NextApiResponse) => (res.status as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
const lockAt = () => h.statements.findIndex((s) => s.includes('pg_advisory_xact_lock'));
const inviterReadAt = () => h.statements.findIndex((s) => /^SELECT role FROM company_users/.test(s));

describe('company-invitations — only a live owner grants owner', () => {
  beforeEach(() => {
    h.statements.length = 0;
    h.inviterRole = 'owner';
    h.userExists = true;
  });

  // withAuth read 'owner' when the request began; the inviter was demoted since.
  it('answers 403 to auto-adding an existing user as owner when the inviter is no longer an owner', async () => {
    h.inviterRole = 'admin';
    const { promise, res } = post('owner', 'owner');
    await promise;
    expect(statusOf(res)).toBe(403);
    expect(JSON.stringify((res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]))
      .toContain('Only an owner can grant the owner role.');
    expect(writes()).toEqual([]);
  });

  it('refuses an owner invitation from a non-owner at the service, writing nothing', async () => {
    h.inviterRole = 'admin';
    h.userExists = false;
    await expect(createInvitation(COMPANY_ID, 'invitee@co.test', 'owner', 'inviter'))
      .rejects.toBeInstanceOf(OwnerProtectedError);
    expect(writes()).toEqual([]);
  });

  it('reads the inviter only after taking the owner lock', async () => {
    h.inviterRole = 'admin';
    await post('owner', 'owner').promise;
    expect(lockAt()).toBeGreaterThanOrEqual(0);
    expect(inviterReadAt()).toBeGreaterThan(lockAt());
  });

  it('lets an owner auto-add an existing user as owner', async () => {
    const { promise, res } = post('owner', 'owner');
    await promise;
    expect(statusOf(res)).toBe(200);
    expect(writes()).toEqual([expect.stringMatching(/^INSERT INTO company_users/)]);
    expect(inviterReadAt()).toBeGreaterThan(lockAt());
  });

  it('lets an owner send an owner invitation', async () => {
    h.userExists = false;
    await expect(createInvitation(COMPANY_ID, 'invitee@co.test', 'owner', 'inviter'))
      .resolves.toMatchObject({ autoAdded: false });
    expect(writes()).toEqual([expect.stringMatching(/^INSERT INTO company_invitations/)]);
  });

  it('takes no owner lock for a non-owner role', async () => {
    h.inviterRole = 'admin';
    const { promise, res } = post('admin', 'viewer');
    await promise;
    expect(statusOf(res)).toBe(200);
    expect(lockAt()).toBe(-1);
    expect(writes()).toHaveLength(1);
  });
});
