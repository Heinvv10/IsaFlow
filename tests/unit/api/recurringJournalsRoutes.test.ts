/**
 * The app's recurring-journal routes after migration 989 (MCP brief step 7, review round 1):
 *  - resume reactivates only a PAUSED template (a completed one's next run is past its end date, a cancelled one is
 *    finished); anything else is a 400 and nothing is written — the page offers Resume on paused only, so this closes
 *    hand-crafted POSTs;
 *  - generate says whether the journal posted, and names it (a draft-only template leaves it a draft);
 *  - create takes `autoPost` as a boolean or not at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_name: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/gl/recurringJournalService', async (orig) => ({
  ...(await orig<object>()),
  updateRecurringJournalStatus: vi.fn(), runRecurringJournal: vi.fn(),
  createRecurringJournal: vi.fn(), getRecurringJournals: vi.fn(), updateRecurringJournalTemplate: vi.fn(),
}));

import {
  createRecurringJournal, runRecurringJournal, updateRecurringJournalStatus, updateRecurringJournalTemplate,
} from '@/modules/accounting/services/gl/recurringJournalService';
import {
  RecurringJournalNotFoundError, RecurringJournalRequestError,
} from '@/modules/accounting/services/gl/recurringJournalGuards';
import actionRoute from '../../../pages/api/accounting/recurring-journals-action';
import createRoute from '../../../pages/api/accounting/recurring-journals';

const ID = '66666666-6666-4666-8666-666666666666';
const COMPANY = '11111111-1111-4111-8111-111111111111';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

function call(handler: Handler, body: unknown) {
  const req = { method: 'POST', query: {}, body, companyId: COMPANY, user: { id: 'u-1' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}

beforeEach(() => { vi.clearAllMocks(); });

describe('recurring-journals-action status actions', () => {
  it.each([['pause', 'paused'], ['resume', 'active'], ['cancel', 'cancelled']])('%s moves to %s', async (action, status) => {
    vi.mocked(updateRecurringJournalStatus).mockResolvedValue({ changed: true });
    const res = await call(actionRoute, { action, id: ID });
    expect(res.statusCode).toBe(200);
    expect(updateRecurringJournalStatus).toHaveBeenCalledWith(COMPANY, ID, status);
  });

  it.each([
    ['pause', 'cancelled', 'This recurring journal is cancelled: it cannot be paused — only an active one can.'],
    ['resume', 'completed', 'This recurring journal is completed: it cannot be resumed — only a paused one can.'],
    ['resume', 'cancelled', 'This recurring journal is cancelled: it cannot be resumed — only a paused one can.'],
    ['cancel', 'completed', 'This recurring journal is completed: it cannot be cancelled — only an active or paused one can.'],
  ])('a refused %s of a %s template is a 400 with the reason', async (action, current, message) => {
    vi.mocked(updateRecurringJournalStatus).mockResolvedValue({ changed: false, current: current as never });
    const res = await call(actionRoute, { action, id: ID });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain(message);
  });

  it('answers a missing (or another company\'s) template 404', async () => {
    vi.mocked(updateRecurringJournalStatus).mockRejectedValue(new RecurringJournalNotFoundError(ID));
    expect((await call(actionRoute, { action: 'resume', id: ID })).statusCode).toBe(404);
  });
});

describe('recurring-journals-action generate', () => {
  it('says whether the journal posted, and names it', async () => {
    vi.mocked(runRecurringJournal).mockResolvedValue({
      journalId: 'je-1', entryNumber: 'JE-000042', posted: false, heldForApproval: [],
    });
    const res = await call(actionRoute, { action: 'generate', id: ID });
    expect(res.statusCode).toBe(200);
    expect((res.sent as { data: unknown }).data).toEqual({
      journalId: 'je-1', entryNumber: 'JE-000042', posted: false, heldForApproval: [],
    });
  });
});

describe('recurring-journals create: autoPost', () => {
  const body = { templateName: 'T', frequency: 'monthly', nextRunDate: '2026-12-01', lines: [] };

  it.each(['false', 0, null, 'yes'])('refuses autoPost %o with a 400, creating nothing', async (autoPost) => {
    const res = await call(createRoute, { ...body, autoPost });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain('autoPost must be true or false');
    expect(createRecurringJournal).not.toHaveBeenCalled();
  });

  it.each([[false, false], [true, true], [undefined, undefined]])('passes autoPost %o through as %o', async (autoPost, passed) => {
    vi.mocked(createRecurringJournal).mockResolvedValue({ id: ID } as never);
    const res = await call(createRoute, autoPost === undefined ? body : { ...body, autoPost });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(createRecurringJournal).mock.calls[0]![1].autoPost).toBe(passed);
  });
});

describe('recurring-journals edit (PUT)', () => {
  const put = (body: unknown) => {
    const req = { method: 'PUT', query: {}, body, companyId: COMPANY, user: { id: 'u-1' } } as unknown as NextApiRequest;
    const res = {
      statusCode: 0, sent: undefined as unknown,
      setHeader() { return this; }, status(code: number) { this.statusCode = code; return this; },
      json(payload: unknown) { this.sent = payload; return this; }, end() { return this; },
    };
    return Promise.resolve((createRoute as Handler)(req, res as unknown as NextApiResponse)).then(() => res);
  };

  it('edits through the service, which owns the next-run-date rules', async () => {
    const res = await put({ id: ID, nextRunDate: '2026-12-15', templateName: 'Rent' });
    expect(res.statusCode).toBe(200);
    expect(updateRecurringJournalTemplate).toHaveBeenCalledWith(COMPANY, ID, 'u-1', {
      templateName: 'Rent', frequency: undefined, nextRunDate: '2026-12-15', description: undefined,
    });
  });

  it('answers the service\'s refusal with its reason, not "Update failed"', async () => {
    vi.mocked(updateRecurringJournalTemplate).mockRejectedValueOnce(
      new RecurringJournalRequestError('The run dated 2026-10-15 has already been generated from this template'));
    const res = await put({ id: ID, nextRunDate: '2026-10-15' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain('already been generated');
  });
});
