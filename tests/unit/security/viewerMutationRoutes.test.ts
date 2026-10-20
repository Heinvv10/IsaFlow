/**
 * Audit 2026-10-18 S-02, S-03, S-05 — mutating AFS, period and reporting-group routes had no role gate.
 * A viewer could sign off an AFS (S-03), add an outside portal contact and email it the management pack
 * (S-02), or create fiscal periods and rewrite reporting groups (S-05). For each route and write method:
 * a viewer is refused 403 by the role gate before any query runs; owner/admin/manager get past it.
 * Only the auth wrappers are mocked; withWriteAccess is the real one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(async () => []), { transaction: vi.fn(), unsafe: vi.fn(async () => []) });
  return {
    sql: sqlFn,
    withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()),
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async (orig) => ({ ...(await orig<typeof import('@/lib/auth')>()), withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', async (orig) => ({ ...(await orig<typeof import('@/lib/rateLimit')>()), checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/bank/vlmService', () => ({ isVlmAvailable: () => false, extractStatutoryDocWithVlm: vi.fn() }));

import { sql } from '@/lib/neon';

type H = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const ROUTES: Array<[string, string[]]> = [
  ['afs/brand-profile', ['PUT']],
  ['afs/generate-pack', ['POST']],
  ['afs/images', ['POST']],
  ['afs/images/[imageId]', ['DELETE']],
  ['afs/index', ['POST']],
  ['afs/management-pack-config', ['PUT']],
  ['afs/management-packs/[packId]/deliver', ['POST']],
  ['afs/portal-contacts', ['POST']],
  ['afs/portal-contacts/[contactId]', ['PUT', 'DELETE']],
  ['afs/[documentId]/generate', ['POST']],
  ['afs/[documentId]/send-for-signing', ['POST']],
  ['afs/[documentId]/sign-off', ['POST']],
  ['afs/[documentId]/submit-for-review', ['POST']],
  ['afs/[documentId]/sections/reorder', ['PUT']],
  ['afs/[documentId]/sections/[sectionId]/ai-narrative', ['POST', 'PUT']],
  ['afs/[documentId]/sections/[sectionId]/comments', ['POST']],
  ['afs/[documentId]/sections/[sectionId]/comments/[commentId]/resolve', ['POST']],
  ['afs/[documentId]/sections/[sectionId]/overrides', ['PUT']],
  ['afs/[documentId]/sections/[sectionId]/regenerate', ['POST']],
  ['afs/[documentId]/sections/[sectionId]/review', ['POST']],
  ['afs/[documentId]/sections/[sectionId]/sign-off', ['POST']],
  ['afs/[documentId]/sections/[sectionId]/suppress', ['POST']],
  ['afs/[documentId]/sections/[sectionId]/versions', ['POST']],
  ['fiscal-periods', ['POST']],
  ['account-reporting-groups', ['POST', 'PATCH', 'DELETE']],
  ['account-reporting-groups/[id]/members', ['POST']],
  ['asset-locations', ['POST', 'PATCH', 'DELETE']],
];
const CASES = ROUTES.flatMap(([route, methods]) => methods.map((m) => [route, m] as const));
const ID = '33333333-3333-4333-8333-333333333333';

async function load(route: string): Promise<H> {
  return (await import(/* @vite-ignore */ `../../../pages/api/accounting/${route}`)).default as H;
}
function makeRes() {
  const res = {
    statusCode: 200, body: undefined as { error?: { message?: string } } | undefined,
    setHeader: vi.fn(), end: vi.fn(), send: vi.fn(),
    status(c: number) { res.statusCode = c; return res; },
    json(b: typeof res.body) { res.body = b; return res; },
  };
  return res;
}
function makeReq(method: string, companyRole: string): NextApiRequest {
  return {
    method, headers: {}, cookies: {},
    query: { documentId: ID, sectionId: ID, commentId: ID, imageId: ID, contactId: ID, packId: ID, id: ID },
    body: { name: 'CFO', email: 'outsider@example.com', role: 'director', year: 2031 },
    companyId: '11111111-1111-4111-8111-111111111111', companyRole, user: { id: 'u-1', email: 'u@example.com' },
  } as unknown as NextApiRequest;
}
const roleRefusal = (res: ReturnType<typeof makeRes>) =>
  res.statusCode === 403 && /does not allow this action/.test(res.body?.error?.message ?? '');

// mockReset, not clearAllMocks: a refused case leaves its unconsumed mockResolvedValueOnce rows queued.
beforeEach(() => { vi.clearAllMocks(); vi.mocked(sql).mockReset().mockImplementation((async () => []) as never); });

describe('viewer refused on every mutating AFS / period / reporting-group route', () => {
  it.each(CASES)('%s %s: a viewer gets 403 before any query', async (route, method) => {
    const handler = await load(route);
    for (const role of ['viewer', 'storeman', 'technician']) {
      const res = makeRes();
      await handler(makeReq(method, role), res as unknown as NextApiResponse);
      expect(roleRefusal(res), `${role}: ${res.statusCode} ${JSON.stringify(res.body)}`).toBe(true);
    }
    expect(sql).not.toHaveBeenCalled();
  });

  it.each(CASES)('%s %s: owner, admin and manager get past the role gate', async (route, method) => {
    const handler = await load(route);
    for (const role of ['owner', 'admin', 'manager']) {
      const res = makeRes();
      // Past the gate the handler runs against an empty mocked DB: it may answer 400/404, or throw on a
      // missing row (withErrorHandler is mocked away). It may not answer 403 for any reason.
      await handler(makeReq(method, role), res as unknown as NextApiResponse).catch(() => undefined);
      expect(res.statusCode, `${role}: ${JSON.stringify(res.body)}`).not.toBe(403);
    }
  });
});

describe('company-documents: the named company\'s role must allow writing', () => {
  // DELETE: 1) find the document's company, 2) the caller's role there, 3) the soft delete.
  const run = async (role: string) => {
    vi.mocked(sql).mockResolvedValueOnce([{ company_id: ID }] as never).mockResolvedValueOnce([{ role }] as never);
    const res = makeRes();
    await (await load('company-documents'))({ ...makeReq('DELETE', 'owner'), query: { id: ID } } as NextApiRequest, res as unknown as NextApiResponse);
    return res;
  };

  it('refuses a viewer of that company (no soft delete), whatever their role in the active company', async () => {
    const res = await run('viewer');
    expect(res.statusCode).toBe(403);
    expect(sql).toHaveBeenCalledTimes(2);
  });

  // POST: 1) the caller's role in the named company, 2) the INSERT. A 1 KB PDF passes the magic-byte and size checks.
  const pdf = `data:application/pdf;base64,${Buffer.from(`%PDF-1.4\n${'x'.repeat(1100)}`).toString('base64')}`;
  const upload = async (role: string) => {
    vi.mocked(sql).mockResolvedValueOnce([{ role }] as never).mockResolvedValueOnce([{ id: ID }] as never);
    const res = makeRes();
    const body = { companyId: ID, documentType: 'cipc', documentName: 'cert.pdf', fileData: pdf, mimeType: 'application/pdf' };
    await (await load('company-documents'))({ ...makeReq('POST', 'owner'), body } as NextApiRequest, res as unknown as NextApiResponse);
    return res;
  };

  it('refuses an upload by a viewer of that company (no INSERT)', async () => {
    const res = await upload('viewer');
    expect(res.statusCode).toBe(403);
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it('lets a manager of that company upload', async () => {
    const res = await upload('manager');
    expect(res.statusCode).toBe(201);
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it('lets a manager of that company delete', async () => {
    const res = await run('manager');
    expect(res.statusCode).toBe(200);
    expect(sql).toHaveBeenCalledTimes(3);
  });
});
