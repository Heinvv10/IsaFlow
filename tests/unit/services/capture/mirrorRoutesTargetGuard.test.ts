/**
 * S-07e part B: both IMAP mirror create routes refuse (400, before anything is
 * written) a host that is or resolves to private space and a port that is not
 * 143 or 993, because the scan cron presents the stored mailbox password to it.
 * Auth wrappers are pass-through here; the guard itself: tests/unit/lib/imapTargetGuard.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

const m = vi.hoisted(() => ({
  lookup: vi.fn(),
  createCapture: vi.fn(),
  createSent: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: m.lookup }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/capture/mirrorConnectionService', () => ({
  listMirrorConnections: vi.fn(), createImapConnection: m.createCapture,
}));
vi.mock('@/modules/accounting/services/ar/sentMirrorAdmin', () => ({
  listSentConnectionSummaries: vi.fn(), createSentImapConnection: m.createSent,
}));

import captureRoute from '../../../../pages/api/accounting/capture/mirror/index';
import sentRoute from '../../../../pages/api/accounting/ar/sent-mirror/connections/index';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const body = (over: Record<string, unknown> = {}) => ({
  displayName: 'Inbox', accountEmail: 'ap@co.test', imapHost: 'imap.gmail.com', imapPort: 993,
  imapUsername: 'ap@co.test', imapPassword: 'pw', ...over,
});

async function post(route: unknown, reqBody: unknown) {
  const out = { status: 0, json: null as { error?: { message?: string } } | null };
  const res = { status(code: number) { out.status = code; return this; }, json(j: typeof out.json) { out.json = j; return this; } };
  const req = { method: 'POST', companyId: COMPANY, user: { id: 'u1' }, body: reqBody };
  await (route as (rq: unknown, rs: NextApiResponse) => Promise<unknown>)(req, res as unknown as NextApiResponse);
  return out;
}

beforeEach(() => {
  vi.resetAllMocks();
  m.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  m.createCapture.mockResolvedValue({ id: 'c1' });
  m.createSent.mockResolvedValue({ id: 's1' });
});

describe.each([
  ['capture mirror', captureRoute, () => m.createCapture],
  ['sent mirror', sentRoute, () => m.createSent],
] as const)('POST %s', (_name, route, created) => {
  it.each([
    ['a loopback host', { imapHost: '127.0.0.1' }, 'This mail server address is not allowed or could not be resolved'],
    ['a private host', { imapHost: '192.168.1.5' }, 'This mail server address is not allowed or could not be resolved'],
    ['the metadata address', { imapHost: '169.254.169.254' }, 'This mail server address is not allowed or could not be resolved'],
    ['a port that is not IMAP', { imapPort: 25 }, 'Only ports 143 and 993 are supported'],
  ])('answers 400 for %s and writes nothing', async (_what, over, message) => {
    const r = await post(route, body(over));
    expect(r.status).toBe(400);
    expect(r.json?.error?.message).toContain(message);
    expect(created()).not.toHaveBeenCalled();
  });

  it('answers 400 for a name that resolves into private space', async () => {
    m.lookup.mockResolvedValue([{ address: '10.0.0.8', family: 4 }]);
    const r = await post(route, body({ imapHost: 'imap.attacker.test' }));
    expect(r.status).toBe(400);
    expect(r.json?.error?.message).toBe('This mail server address is not allowed or could not be resolved');
    expect(JSON.stringify(r.json)).not.toContain('10.0.0.8'); // which address it resolved to is not the tenant's to learn
    expect(created()).not.toHaveBeenCalled();
  });

  it.each([[143], [993]])('creates the connection for a public host on port %i', async (imapPort) => {
    const r = await post(route, body({ imapPort }));
    expect(r.status).toBe(201);
    expect(created()).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY, imapHost: 'imap.gmail.com', imapPort }));
  });
});
