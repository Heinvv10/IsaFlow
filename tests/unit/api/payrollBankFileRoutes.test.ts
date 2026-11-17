/**
 * The salary bank-file routes' gate (wave 6 BF, spec rule 14): payroll-detail roles read; only an owner or admin,
 * signed in as themselves, not under Login-as, writes. Every answer is no-store, and a refused write reaches no
 * service. Wiring only: the figures and tenancy are proven on real PG (tests/integration/payroll-bank-file).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mocks = vi.hoisted(() => ({ actor: vi.fn(), generate: vi.fn(), settle: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth/impersonationSessions', () => ({ currentSessionActor: mocks.actor }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollBankFileService', () => ({ generateSalaryBankFile: mocks.generate }));
vi.mock('@/modules/accounting/services/payroll/payrollBankFileConfirm', () => ({ settleBankFile: mocks.settle }));
vi.mock('@/modules/accounting/services/payroll/payrollBankFileStatus', async (orig) => ({
  ...(await orig<object>()), readRunBankFileState: mocks.read,
}));

import bankFile from '../../../pages/api/payroll/runs/[id]/bank-file/index';
import settle from '../../../pages/api/payroll/runs/[id]/bank-file/[fileId]/[action]';
import { PayrollBankFileRefusal } from '@/modules/accounting/services/payroll/payrollBankFileStatus';

const RUN = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
type H = (a: NextApiRequest, b: NextApiResponse) => Promise<void>;

function call(h: unknown, method: string, role: string, query: Record<string, string>, body?: unknown) {
  const out = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = {
    setHeader: (k: string, v: string) => { out.headers[k] = v; },
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; return res; },
    end() { return res; },
  } as unknown as NextApiResponse;
  const req = { method, query, body, headers: {}, socket: {}, companyId: 'co-a', companyRole: role,
    user: { id: 'u1', email: 'u1@example.invalid', claims: { session_id: 's1' } } } as unknown as NextApiRequest;
  return (h as H)(req, res).then(() => out);
}
const gen = (role: string) => call(bankFile, 'POST', role, { id: RUN }, { actionDate: '2099-01-15' });
const conf = (role: string) => call(settle, 'POST', role, { id: RUN, fileId: FILE, action: 'confirm' });

describe('salary bank-file routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actor.mockResolvedValue('self');
    mocks.generate.mockResolvedValue({ id: FILE, content: 'x' });
    mocks.settle.mockResolvedValue({ id: FILE, status: 'confirmed' });
    mocks.read.mockResolvedValue({ enabled: false, files: [], paymentConfirmed: false });
  });

  it('a manager reads the state but cannot write; a viewer cannot read', async () => {
    expect((await call(bankFile, 'GET', 'manager', { id: RUN })).status).toBe(200);
    expect((await call(bankFile, 'GET', 'viewer', { id: RUN })).status).toBe(403);
    expect((await gen('manager')).status).toBe(403);
    expect((await conf('manager')).status).toBe(403);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('an owner and an admin write, with their session as the actor', async () => {
    expect((await gen('owner')).status).toBe(200);
    expect((await conf('admin')).status).toBe(200);
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'co-a', runId: RUN, actionDate: '2099-01-15', actor: expect.objectContaining({ userId: 'u1', sessionId: 's1' }),
    }));
  });

  it.each([['unknown', 'AGENT_FORBIDDEN'], ['impersonation', 'IMPERSONATION_FORBIDDEN']])('refuses a %s session on every write', async (actor, reason) => {
    mocks.actor.mockResolvedValue(actor);
    for (const r of [await gen('owner'), await conf('owner'), await call(settle, 'POST', 'owner', { id: RUN, fileId: FILE, action: 'void' })]) {
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).toContain(reason);
    }
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('every answer, refusals included, is no-store', async () => {
    for (const r of [await gen('owner'), await gen('viewer'), await call(bankFile, 'GET', 'viewer', { id: RUN }), await conf('manager')]) {
      expect(r.headers['Cache-Control']).toBe('no-store');
    }
  });

  it('a service refusal answers its status and reason; an unknown action is 404; a bad date is 400', async () => {
    mocks.generate.mockRejectedValue(new PayrollBankFileRefusal('BANK_HAS_PAID', 'paid'));
    const r = await gen('owner');
    expect([r.status, JSON.stringify(r.body)]).toEqual([409, expect.stringContaining('BANK_HAS_PAID')]);
    expect((await call(settle, 'POST', 'owner', { id: RUN, fileId: FILE, action: 'pay' })).status).toBe(404);
    expect((await call(bankFile, 'POST', 'owner', { id: RUN }, { actionDate: '15/01/2099' })).status).toBe(400);
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('void passes the not-sent attestation only when the body says true', async () => {
    await call(settle, 'POST', 'owner', { id: RUN, fileId: FILE, action: 'void' }, { notSentToBank: true });
    await call(settle, 'POST', 'owner', { id: RUN, fileId: FILE, action: 'void' }, { notSentToBank: 'yes' });
    expect(mocks.settle.mock.calls.map((c) => [c[0].action, c[0].notSentToBank])).toEqual([['void', true], ['void', false]]);
  });
});
