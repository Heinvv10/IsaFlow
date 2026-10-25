/**
 * S-07e part B, review round 8: one tenant must not stall the serial scan cron for the others
 * through its own connections. The routes bound scanIntervalMinutes (a whole number of minutes,
 * 5 to 1440) on create and PATCH, for both mirrors, and answer 409 when the company already
 * holds its limit of active connections. The cap itself is counted in the service (mirrorConnectionWrites
 * and sentMirrorAdmin tests) and the selection on a real database
 * (tests/integration/s07e-b-routes-paths-due.int.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

const m = vi.hoisted(() => ({
  createCapture: vi.fn(), createSent: vi.fn(), updateCapture: vi.fn(), updateSent: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/capture/mirrorConnectionService', () => ({
  listMirrorConnections: vi.fn(), createImapConnection: m.createCapture,
  updateConnectionSenders: m.updateCapture, deleteConnection: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/sentMirrorAdmin', () => ({
  listSentConnectionSummaries: vi.fn(), createSentImapConnection: m.createSent,
  updateSentConnection: m.updateSent, deleteSentConnection: vi.fn(),
}));

import captureCreate from '../../../../pages/api/accounting/capture/mirror/index';
import sentCreate from '../../../../pages/api/accounting/ar/sent-mirror/connections/index';
import captureUpdate from '../../../../pages/api/accounting/capture/mirror/[id]/index';
import sentUpdate from '../../../../pages/api/accounting/ar/sent-mirror/connections/[id]/index';
import {
  MAX_ACTIVE_CONNECTIONS_PER_COMPANY, MirrorConnectionCapError, scanIntervalError,
} from '@/modules/accounting/services/capture/mirrorLimits';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const createBody = (over: Record<string, unknown> = {}) => ({
  displayName: 'Inbox', accountEmail: 'ap@co.test', imapHost: 'imap.gmail.com', imapPort: 993,
  imapUsername: 'ap@co.test', imapPassword: 'pw', ...over,
});

async function call(route: unknown, method: string, reqBody: unknown, query: Record<string, string> = {}) {
  const out = { status: 0, json: null as { error?: { message?: string; details?: { reason?: string } } } | null };
  const res = { status(code: number) { out.status = code; return this; }, json(j: typeof out.json) { out.json = j; return this; } };
  const req = { method, companyId: COMPANY, user: { id: 'u1' }, body: reqBody, query };
  await (route as (rq: unknown, rs: NextApiResponse) => Promise<unknown>)(req, res as unknown as NextApiResponse);
  return out;
}

beforeEach(() => {
  vi.resetAllMocks();
  m.createCapture.mockResolvedValue({ id: 'c1' });
  m.createSent.mockResolvedValue({ id: 's1' });
  m.updateCapture.mockResolvedValue({ id: ID });
  m.updateSent.mockResolvedValue({ id: ID });
});

describe('scanIntervalError', () => {
  it.each([[undefined], [null], [5], [10], [60], [1440]])('accepts %s', (v) => {
    expect(scanIntervalError(v)).toBeNull();
  });
  it.each([[0], [1], [4], [-5], [1441], [5.5], ['10'], [NaN], [Infinity], [true], [[]], [{}]])('refuses %s', (v) => {
    expect(scanIntervalError(v)).toMatch(/whole number of minutes from 5 to 1440/);
  });
});

const BAD_INTERVALS = [[0], [1], [4], [-1], [1441], [7.5], ['5']] as const;

describe.each([
  ['capture mirror create', captureCreate, () => m.createCapture],
  ['sent mirror create', sentCreate, () => m.createSent],
] as const)('POST %s', (_name, route, created) => {
  it.each(BAD_INTERVALS)('answers 400 for scanIntervalMinutes %s and writes nothing', async (bad) => {
    const r = await call(route, 'POST', createBody({ scanIntervalMinutes: bad }));
    expect(r.status).toBe(400);
    expect(created()).not.toHaveBeenCalled();
  });

  it.each([[5], [1440]])('accepts the bound %i', async (scanIntervalMinutes) => {
    const r = await call(route, 'POST', createBody({ scanIntervalMinutes }));
    expect(r.status).toBe(201);
    expect(created()).toHaveBeenCalledWith(expect.objectContaining({ scanIntervalMinutes }));
  });

  it(`answers 409 when the company already holds ${MAX_ACTIVE_CONNECTIONS_PER_COMPANY} active connections`, async () => {
    created().mockRejectedValue(new MirrorConnectionCapError('mirror'));
    const r = await call(route, 'POST', createBody());
    expect(r.status).toBe(409);
    expect(r.json?.error?.message).toContain(`at most ${MAX_ACTIVE_CONNECTIONS_PER_COMPANY} active`);
  });

  it('does not turn another failure into a 409', async () => {
    created().mockRejectedValue(new Error('boom'));
    await expect(call(route, 'POST', createBody())).rejects.toThrow('boom');
  });
});

describe.each([
  ['capture mirror PATCH', captureUpdate, () => m.updateCapture],
  ['sent mirror PATCH', sentUpdate, () => m.updateSent],
] as const)('%s', (_name, route, updated) => {
  it.each(BAD_INTERVALS)('answers 400 for scanIntervalMinutes %s and writes nothing', async (bad) => {
    const r = await call(route, 'PATCH', { scanIntervalMinutes: bad }, { id: ID });
    expect(r.status).toBe(400);
    expect(updated()).not.toHaveBeenCalled();
  });

  it('passes a valid interval through, and an absent one (the other fields alone)', async () => {
    expect((await call(route, 'PATCH', { scanIntervalMinutes: 15 }, { id: ID })).status).toBe(200);
    expect(updated()).toHaveBeenLastCalledWith(expect.objectContaining({ scanIntervalMinutes: 15 }));
    expect((await call(route, 'PATCH', {}, { id: ID })).status).toBe(200);
  });
});
