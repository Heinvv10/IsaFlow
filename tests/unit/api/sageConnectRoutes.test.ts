/**
 * The HTTP face of "Import from Sage" (pages/api/accounting/sage-connect/*):
 * who may call each route (every one needs a session; the writes need write
 * access), that the company always comes from the session and never the body,
 * what each refuses before touching anything, and the background-read flow —
 * preview answers at once with a 'pulling' id and queues the read after the
 * commit; /pulls/{id} reports the row and, once ready, the review.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  class SagePullRefused extends Error {}
  class SageImportRefused extends Error { constructor(msg: string, readonly issues: unknown[] = []) { super(msg); } }
  return {
    SagePullRefused, SageImportRefused,
    startPull: vi.fn(), loadPullState: vi.fn(), purgeExpiredPulls: vi.fn(), latestOpenPull: vi.fn(), discardPull: vi.fn(),
    findPriorTakeOn: vi.fn(), readTakeOnContext: vi.fn(), buildSageTakeOn: vi.fn(),
    pullSlotRefusal: vi.fn(), runSagePull: vi.fn(), runAfterCommit: vi.fn(), importSagePull: vi.fn(),
  };
});

// withAuth: a request with no session is refused 401; withWriteAccess: a read-only member 403.
vi.mock('@/lib/auth', () => ({
  withAuth: (fn: (q: Record<string, unknown>, s: { status: (n: number) => { json: (b: unknown) => void } }) => unknown) =>
    (q: Record<string, unknown>, s: { status: (n: number) => { json: (b: unknown) => void } }) =>
      (q.companyId ? fn(q, s) : s.status(401).json({ success: false })),
  withWriteAccess: (fn: (q: Record<string, unknown>, s: { status: (n: number) => { json: (b: unknown) => void } }) => unknown) =>
    (q: Record<string, unknown>, s: { status: (n: number) => { json: (b: unknown) => void } }) =>
      (q.readOnly ? s.status(403).json({ success: false }) : fn(q, s)),
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: m.runAfterCommit }));
vi.mock('@/lib/apiJournalDate', () => ({ JOURNAL_DATE_REFUSED: Symbol('r'), withJournalDateRefusal: (_r: unknown, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/sage/sageTakeOnStore', () => ({
  SagePullRefused: m.SagePullRefused, startPull: m.startPull, loadPullState: m.loadPullState,
  purgeExpiredPulls: m.purgeExpiredPulls, latestOpenPull: m.latestOpenPull, discardPull: m.discardPull,
}));
vi.mock('@/modules/accounting/services/sage/sageTakeOnContext', () => ({ findPriorTakeOn: m.findPriorTakeOn, readTakeOnContext: m.readTakeOnContext }));
vi.mock('@/modules/accounting/services/sage/sageTakeOnBuilder', () => ({ buildSageTakeOn: m.buildSageTakeOn }));
vi.mock('@/modules/accounting/services/sage/sagePullJob', () => ({ pullSlotRefusal: m.pullSlotRefusal, runSagePull: m.runSagePull }));
vi.mock('@/modules/accounting/services/sage/sageTakeOnImportService', () => ({ importSagePull: m.importSagePull, SageImportRefused: m.SageImportRefused }));

import preview from '../../../pages/api/accounting/sage-connect/preview';
import pull from '../../../pages/api/accounting/sage-connect/pulls/[pullId]';
import status from '../../../pages/api/accounting/sage-connect/status';
import discard from '../../../pages/api/accounting/sage-connect/discard';
import importRoute from '../../../pages/api/accounting/sage-connect/import';
import { sageFixture, emptyCompany } from '../services/sage/sageFixture';

const CO = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PULL = '33333333-3333-4333-8333-333333333333';
const login = { email: 'owner@acme.test', password: 's3cret!', sageCompanyId: 555 };

type Req = { method: string; body?: unknown; query?: Record<string, string>; companyId?: string; readOnly?: boolean };
async function call(handler: unknown, req: Req): Promise<{ statusCode: number; body: { data?: Record<string, unknown>; error?: { message?: string } } }> {
  const state = { statusCode: 0, body: {} as never };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: never) { state.body = payload; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  await (handler as (q: unknown, s: unknown) => Promise<void>)({ user: { id: 'u-1' }, query: {}, ...req }, res);
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SAGE_API_KEY = 'vendor-key';
  m.findPriorTakeOn.mockResolvedValue(null);
  m.pullSlotRefusal.mockReturnValue(null);
  m.startPull.mockResolvedValue(PULL);
  m.latestOpenPull.mockResolvedValue(null);
});

describe('who may call', () => {
  it.each([
    ['preview', preview, 'POST'], ['pulls', pull, 'GET'], ['status', status, 'GET'], ['discard', discard, 'POST'], ['import', importRoute, 'POST'],
  ])('%s needs a session', async (_n, handler, method) => {
    expect((await call(handler, { method, body: login })).statusCode).toBe(401);
  });

  it.each([['preview', preview], ['discard', discard], ['import', importRoute]])('%s needs write access', async (_n, handler) => {
    const out = await call(handler, { method: 'POST', body: { ...login, pullId: PULL }, companyId: CO, readOnly: true });
    expect(out.statusCode).toBe(403);
    expect(m.startPull).not.toHaveBeenCalled();
    expect(m.importSagePull).not.toHaveBeenCalled();
    expect(m.discardPull).not.toHaveBeenCalled();
  });
});

describe('POST preview: starts the read in the background', () => {
  it('answers at once with the pulling row, for the session\'s company, and queues the read after commit', async () => {
    const out = await call(preview, { method: 'POST', body: { ...login, companyId: OTHER }, companyId: CO });
    expect(out.statusCode).toBe(200);
    expect(out.body.data).toEqual({ pullId: PULL, status: 'pulling' });
    expect(m.startPull).toHaveBeenCalledWith(CO, 'u-1', 555, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(m.runAfterCommit).toHaveBeenCalledWith('sage pull', expect.any(Function));
    expect(m.runSagePull).not.toHaveBeenCalled(); // not inside the request

    await (m.runAfterCommit.mock.calls[0]![1] as () => Promise<void>)();
    expect(m.runSagePull).toHaveBeenCalledWith(expect.objectContaining({ companyId: CO, pullId: PULL, sageCompanyId: 555 }));
    // The login travels in the client object only; nothing it was handed is a string carrying it.
    const job = m.runSagePull.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.values(job).filter((v) => typeof v === 'string').join('|')).not.toContain('s3cret!');
  });

  it.each([
    ['no company chosen', { ...login, sageCompanyId: undefined }],
    ['no email', { ...login, email: '' }],
    ['no password', { ...login, password: '' }],
  ])('refuses %s before anything is written', async (_n, body) => {
    expect((await call(preview, { method: 'POST', body, companyId: CO })).statusCode).toBe(422);
    expect(m.startPull).not.toHaveBeenCalled();
  });

  it('refuses when the connection is switched off', async () => {
    process.env.SAGE_API_KEY = '';
    expect((await call(preview, { method: 'POST', body: login, companyId: CO })).statusCode).toBe(400);
    expect(m.startPull).not.toHaveBeenCalled();
  });

  it('refuses a company that already has a take-on', async () => {
    m.findPriorTakeOn.mockResolvedValue('already has its books from Sage');
    const out = await call(preview, { method: 'POST', body: login, companyId: CO });
    expect(out.statusCode).toBe(400);
    expect(out.body.error?.message).toContain('already has its books');
    expect(m.startPull).not.toHaveBeenCalled();
  });

  it('refuses when every pull slot is busy', async () => {
    m.pullSlotRefusal.mockReturnValue('busy now');
    expect((await call(preview, { method: 'POST', body: login, companyId: CO })).body.error?.message).toBe('busy now');
    expect(m.pullSlotRefusal).toHaveBeenCalledWith(CO);
    expect(m.startPull).not.toHaveBeenCalled();
  });

  it('answers a read already running for the company as a 400, queueing nothing', async () => {
    m.startPull.mockRejectedValue(new m.SagePullRefused('already reading'));
    const out = await call(preview, { method: 'POST', body: login, companyId: CO });
    expect(out.statusCode).toBe(400);
    expect(m.runAfterCommit).not.toHaveBeenCalled();
  });
});

describe('GET pulls/{pullId}: the poll', () => {
  it('reports a read under way, scoped to the session\'s company, after expiring stale rows', async () => {
    m.loadPullState.mockResolvedValue({ id: PULL, status: 'pulling', progress: 'Reading customers', error: null, pull: null });
    const out = await call(pull, { method: 'GET', query: { pullId: PULL }, companyId: CO });
    expect(m.purgeExpiredPulls).toHaveBeenCalledWith(CO);
    expect(m.loadPullState).toHaveBeenCalledWith(CO, PULL);
    expect(out.body.data).toEqual({ pullId: PULL, status: 'pulling', progress: 'Reading customers', error: null, review: null });
  });

  it('builds the review once ready, against the chart as it is now', async () => {
    m.loadPullState.mockResolvedValue({ id: PULL, status: 'ready', progress: null, error: null, pull: sageFixture(), summary: { profitAndLossFold: null } });
    m.readTakeOnContext.mockResolvedValue(emptyCompany);
    const real = await vi.importActual<typeof import('@/modules/accounting/services/sage/sageTakeOnBuilder')>('@/modules/accounting/services/sage/sageTakeOnBuilder');
    m.buildSageTakeOn.mockImplementation(real.buildSageTakeOn);
    const out = await call(pull, { method: 'GET', query: { pullId: PULL }, companyId: CO });
    const review = out.body.data!.review as { sageCompany: { name: string }; customers: string[] };
    expect(review.sageCompany.name).toBe('Acme Media (Pty) Ltd');
    // Names and amounts only: no contact details leave the server.
    expect(JSON.stringify(review)).not.toContain('ap@bright.test');
    expect(m.readTakeOnContext).toHaveBeenCalledWith(CO, '2026-10-21');
  });

  it('a ready review whose fold no longer matches IsaFlow is shown with a blocking out-of-date issue', async () => {
    m.loadPullState.mockResolvedValue({ id: PULL, status: 'ready', progress: null, error: null, pull: sageFixture(), summary: { profitAndLossFold: null } });
    m.readTakeOnContext.mockResolvedValue({ ...emptyCompany, fiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31' } });
    const real = await vi.importActual<typeof import('@/modules/accounting/services/sage/sageTakeOnBuilder')>('@/modules/accounting/services/sage/sageTakeOnBuilder');
    m.buildSageTakeOn.mockImplementation(real.buildSageTakeOn);
    const out = await call(pull, { method: 'GET', query: { pullId: PULL }, companyId: CO });
    const issues = (out.body.data!.review as { issues: { severity: string; message: string }[] }).issues;
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'error', message: expect.stringMatching(/out of date/i) }));
  });

  it('reports a failed read with its safe message', async () => {
    m.loadPullState.mockResolvedValue({ id: PULL, status: 'failed', progress: null, error: 'Sage did not accept that email address or password.', pull: null });
    const out = await call(pull, { method: 'GET', query: { pullId: PULL }, companyId: CO });
    expect(out.body.data).toMatchObject({ status: 'failed', error: expect.stringContaining('Sage did not accept'), review: null });
  });

  it('answers 404 for a row that is not this company\'s, and 422 for a malformed id', async () => {
    m.loadPullState.mockResolvedValue(null);
    expect((await call(pull, { method: 'GET', query: { pullId: PULL }, companyId: CO })).statusCode).toBe(404);
    expect((await call(pull, { method: 'GET', query: { pullId: 'nope' }, companyId: CO })).statusCode).toBe(422);
  });
});

describe('status, discard, import', () => {
  it('status reports the review to resume and any prior take-on, for the session\'s company', async () => {
    m.latestOpenPull.mockResolvedValue({ pullId: PULL, status: 'pulling' });
    const out = await call(status, { method: 'GET', companyId: CO });
    expect(out.body.data).toEqual({ available: true, open: { pullId: PULL, status: 'pulling' }, priorTakeOn: null });
    expect(m.purgeExpiredPulls).toHaveBeenCalledWith(CO);
  });

  it('discard works on the session\'s company and answers 404 when nothing matched', async () => {
    m.discardPull.mockResolvedValue(true);
    expect((await call(discard, { method: 'POST', body: { pullId: PULL }, companyId: CO })).statusCode).toBe(200);
    expect(m.discardPull).toHaveBeenCalledWith(CO, PULL);
    m.discardPull.mockResolvedValue(false);
    expect((await call(discard, { method: 'POST', body: { pullId: PULL }, companyId: CO })).statusCode).toBe(404);
  });

  it('import answers a refusal as a 400 with its issues', async () => {
    m.importSagePull.mockRejectedValue(new m.SageImportRefused('no', [{ severity: 'error', area: 'company', message: 'x' }]));
    const out = await call(importRoute, { method: 'POST', body: { pullId: PULL }, companyId: CO });
    expect(out.statusCode).toBe(400);
    expect(m.importSagePull).toHaveBeenCalledWith(CO, 'u-1', PULL);
    expect(JSON.stringify(out.body)).toContain('"area":"company"');
  });
});
