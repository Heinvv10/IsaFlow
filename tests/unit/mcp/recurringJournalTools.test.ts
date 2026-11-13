/**
 * create_recurring_journal / deactivate_recurring_journal (MCP brief step 7). The template is checked by
 * create_draft_journal's line rules (checkJournalLines, covered by its own suites) AND the read guards a run applies
 * before its first write; an auto-posting template needs write:post; a dry run writes nothing and frees the key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn().mockResolvedValue([]), withTransaction: vi.fn(), withSavepoint: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/recurringJournalService', () => ({
  createRecurringJournal: vi.fn(), getRecurringJournalById: vi.fn(), updateRecurringJournalStatus: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/recurringJournalGuards', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/recurringJournalGuards')>()),
  assertTemplateLinesPostable: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/headerAccountGuard', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/headerAccountGuard')>()),
  assertNoHeaderAccountLines: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionPolicy', () => ({ assertNewJournalDimensions: vi.fn() }));
vi.mock('@/lib/mcp/tools/journalLineArgs', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/tools/journalLineArgs')>()),
  checkJournalLines: vi.fn(),
}));

import {
  createRecurringJournal, getRecurringJournalById, updateRecurringJournalStatus,
} from '@/modules/accounting/services/gl/recurringJournalService';
import {
  RecurringJournalRequestError, assertTemplateLinesPostable,
} from '@/modules/accounting/services/gl/recurringJournalGuards';
import { HeaderAccountRefusal, assertNoHeaderAccountLines } from '@/modules/accounting/services/gl/headerAccountGuard';
import { assertNewJournalDimensions } from '@/modules/accounting/services/gl/dimensions/dimensionPolicy';
import { PreWriteDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { checkJournalLines } from '@/lib/mcp/tools/journalLineArgs';
import { createRecurringJournalTool, deactivateRecurringJournalTool } from '@/lib/mcp/tools/writeRecurringJournals';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const RJ = 'a1a1a1a1-0000-4000-8000-000000000001';
const DR = 'd0d0d0d0-0000-4000-8000-000000000001';
const CR = 'c0c0c0c0-0000-4000-8000-000000000002';
const ctx = (scopes = ['write:journals']) =>
  ({ companyId: 'cccccccc-0000-4000-8000-cccccccccccc', userId: 'u-1', tokenJti: 'jti', scopes }) as unknown as McpToolContext;
const text = (r: McpToolResult) => r.content[0]!.text;
const body = (r: McpToolResult) => JSON.parse(text(r)) as Record<string, unknown>;
const LINES = [{ glAccountId: DR, debit: 500, credit: 0, cc2Id: 'p-1' }, { glAccountId: CR, debit: 0, credit: 500 }];
const ARGS = {
  name: 'Rent accrual', frequency: 'monthly', start_date: '2026-11-30',
  lines: [{ account_id: DR, debit: 500, credit: 0, cc2: 'P1' }, { account_id: CR, debit: 0, credit: 500 }],
  idempotency_key: 'k-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkJournalLines).mockResolvedValue({ lines: LINES, warnings: [] });
  vi.mocked(createRecurringJournal).mockResolvedValue({ id: RJ, status: 'active' } as never);
  vi.mocked(updateRecurringJournalStatus).mockResolvedValue({ changed: true });
});

describe('create_recurring_journal', () => {
  it('is a write:journals tool that does not itself require write:post', () => {
    expect(createRecurringJournalTool.scope).toBe('write:journals');
    expect(createRecurringJournalTool.write).toBe(true);
    expect(createRecurringJournalTool.requiresPost).toBeUndefined();
  });

  it.each([
    [{ name: undefined }, 'name is required'],
    [{ frequency: 'daily' }, 'frequency must be one of: weekly, monthly, quarterly, annually'],
    [{ start_date: undefined }, 'start_date is required (YYYY-MM-DD)'],
    [{ start_date: '2026-02-30' }, 'invalid start_date'],
    [{ end_date: '2026-11-29' }, 'end_date must be on or after start_date'],
    [{ start_date: '2300-01-01' }, 'Date 2300-01-01 is outside 1900-01-01 to 2199-12-31'],
    [{ auto_post: 'yes' }, 'auto_post must be true or false'],
  ])('refuses %o before checking a line', async (over, message) => {
    const r = await createRecurringJournalTool.handler({ ...ARGS, ...over }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(message);
    expect(checkJournalLines).not.toHaveBeenCalled();
    expect(createRecurringJournal).not.toHaveBeenCalled();
  });

  it('refuses an auto-posting template without write:post, and creates one with it', async () => {
    const refused = await createRecurringJournalTool.handler({ ...ARGS, auto_post: true }, ctx());
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('write:post');
    expect(createRecurringJournal).not.toHaveBeenCalled();

    const made = await createRecurringJournalTool.handler({ ...ARGS, auto_post: true }, ctx(['write:journals', 'write:post']));
    expect(made.isError).toBeFalsy();
    expect(vi.mocked(createRecurringJournal).mock.calls[0]![1]).toMatchObject({ autoPost: true });
  });

  it('holds the lines to create_draft_journal\'s rules', async () => {
    vi.mocked(checkJournalLines).mockResolvedValue('One or more account_id values are not GL accounts in your company.');
    const r = await createRecurringJournalTool.handler(ARGS, ctx());
    expect(text(r)).toBe('One or more account_id values are not GL accounts in your company.');
    expect(vi.mocked(checkJournalLines).mock.calls[0]!.slice(1)).toEqual([ARGS.lines, 'create_recurring_journal']);
    expect(createRecurringJournal).not.toHaveBeenCalled();
  });

  it.each([
    ['lines that do not balance or name a deactivated account', () => vi.mocked(assertTemplateLinesPostable)
      .mockRejectedValueOnce(new RecurringJournalRequestError('posts to deactivated GL account: 6000 Rent'))],
    ['a balance-sheet header account', () => vi.mocked(assertNoHeaderAccountLines)
      .mockRejectedValueOnce(new HeaderAccountRefusal('Line 1 is on a header account', 0))],
    ['dimensions a new journal may not carry', () => vi.mocked(assertNewJournalDimensions)
      .mockRejectedValueOnce(new PreWriteDimensionRefusal('Line 1: inactive FNO', 0))],
  ])('refuses %s with the run guard\'s own message, writing nothing', async (_label, arm) => {
    arm();
    const r = await createRecurringJournalTool.handler(ARGS, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/deactivated GL account|header account|inactive FNO/);
    expect(createRecurringJournal).not.toHaveBeenCalled();
  });

  it('rethrows anything that is not a refusal', async () => {
    vi.mocked(assertTemplateLinesPostable).mockRejectedValueOnce(new Error('connection reset'));
    await expect(createRecurringJournalTool.handler(ARGS, ctx())).rejects.toThrow('connection reset');
  });

  it('dry run: every guard runs, nothing is written, and the key is freed', async () => {
    const r = await createRecurringJournalTool.handler({ ...ARGS, dry_run: true }, ctx());
    expect(r.wroteNothing).toBe(true);
    expect(body(r)).toMatchObject({ dry_run: true, would_create: { template_name: 'Rent accrual', total_amount: 500, auto_post: false } });
    expect(assertTemplateLinesPostable).toHaveBeenCalledWith(expect.any(String), LINES);
    expect(assertNoHeaderAccountLines).toHaveBeenCalled();
    expect(assertNewJournalDimensions).toHaveBeenCalledWith(expect.any(String), 'auto_recurring', LINES);
    expect(createRecurringJournal).not.toHaveBeenCalled();
  });

  it('dry run refuses what the live call refuses', async () => {
    vi.mocked(assertTemplateLinesPostable).mockRejectedValueOnce(new RecurringJournalRequestError('does not balance'));
    const r = await createRecurringJournalTool.handler({ ...ARGS, dry_run: true }, ctx());
    expect(r.isError).toBe(true);
    expect(r.wroteNothing).toBeUndefined();
  });

  it('live: stores the checked lines as a draft-only template and says how to undo it', async () => {
    const r = await createRecurringJournalTool.handler({ ...ARGS, description: 'Office rent', end_date: '2027-10-31' }, ctx());
    expect(r.wroteNothing).toBeUndefined();
    expect(createRecurringJournal).toHaveBeenCalledWith('cccccccc-0000-4000-8000-cccccccccccc', {
      templateName: 'Rent accrual', description: 'Office rent', frequency: 'monthly', nextRunDate: '2026-11-30',
      endDate: '2027-10-31', lines: LINES, autoPost: false,
    }, 'u-1');
    expect(body(r)).toMatchObject({ recurring_journal_id: RJ, status: 'active', next_run_date: '2026-11-30' });
    expect(String(body(r).undo)).toContain('deactivate_recurring_journal');
  });
});

function template(status: string, autoPost = false) {
  vi.mocked(getRecurringJournalById).mockResolvedValue({ id: RJ, templateName: 'Rent accrual', status, autoPost } as never);
}

describe('deactivate_recurring_journal', () => {
  it('refuses a missing or malformed id before reading', async () => {
    expect(text(await deactivateRecurringJournalTool.handler({ idempotency_key: 'k' }, ctx()))).toBe('recurring_journal_id is required');
    expect(text(await deactivateRecurringJournalTool.handler({ recurring_journal_id: 'x', idempotency_key: 'k' }, ctx())))
      .toBe('invalid recurring_journal_id');
    expect(getRecurringJournalById).not.toHaveBeenCalled();
  });

  it('answers another company\'s id exactly as a miss', async () => {
    vi.mocked(getRecurringJournalById).mockResolvedValue(null);
    expect(text(await deactivateRecurringJournalTool.handler({ recurring_journal_id: RJ, idempotency_key: 'k' }, ctx()))).toBe('Not found');
  });

  it('pauses an active template, predicated on it still being active', async () => {
    template('active');
    const r = await deactivateRecurringJournalTool.handler({ recurring_journal_id: RJ, idempotency_key: 'k' }, ctx());
    expect(body(r)).toMatchObject({ status: 'paused', previous_status: 'active' });
    expect(updateRecurringJournalStatus).toHaveBeenCalledWith(expect.any(String), RJ, 'paused', 'active');
  });

  it.each(['paused', 'completed', 'cancelled'])('pausing a %s template writes nothing and frees the key', async (status) => {
    template(status);
    const r = await deactivateRecurringJournalTool.handler({ recurring_journal_id: RJ, idempotency_key: 'k' }, ctx());
    expect(body(r)).toMatchObject({ status, already: true });
    expect(r.wroteNothing).toBe(true);
    expect(updateRecurringJournalStatus).not.toHaveBeenCalled();
  });

  it('resumes a paused template; one that auto-posts needs write:post', async () => {
    template('paused', true);
    const refused = await deactivateRecurringJournalTool.handler({ recurring_journal_id: RJ, enable: true, idempotency_key: 'k' }, ctx());
    expect(text(refused)).toContain('write:post');
    expect(updateRecurringJournalStatus).not.toHaveBeenCalled();
    const r = await deactivateRecurringJournalTool.handler(
      { recurring_journal_id: RJ, enable: true, idempotency_key: 'k' }, ctx(['write:journals', 'write:post']));
    expect(body(r)).toMatchObject({ status: 'active', previous_status: 'paused' });
    expect(updateRecurringJournalStatus).toHaveBeenCalledWith(expect.any(String), RJ, 'active', 'paused');
  });

  it.each(['completed', 'cancelled'])('refuses to resume a %s template', async (status) => {
    template(status);
    const r = await deactivateRecurringJournalTool.handler({ recurring_journal_id: RJ, enable: true, idempotency_key: 'k' }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`A ${status} recurring journal cannot be resumed`);
    expect(updateRecurringJournalStatus).not.toHaveBeenCalled();
  });

  it('a status changed since the read is answered as a refusal (nothing was written), anything else rethrows', async () => {
    template('active');
    vi.mocked(updateRecurringJournalStatus).mockResolvedValueOnce({ changed: false, current: 'cancelled' });
    const r = await deactivateRecurringJournalTool.handler({ recurring_journal_id: RJ, idempotency_key: 'k' }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('status changed concurrently (now cancelled) — re-read it and retry');
    vi.mocked(updateRecurringJournalStatus).mockRejectedValueOnce(new Error('connection reset'));
    await expect(deactivateRecurringJournalTool.handler({ recurring_journal_id: RJ, idempotency_key: 'k' }, ctx()))
      .rejects.toThrow('connection reset');
  });

  it('dry run checks the same and writes nothing', async () => {
    template('active');
    const r = await deactivateRecurringJournalTool.handler({ recurring_journal_id: RJ, dry_run: true, idempotency_key: 'k' }, ctx());
    expect(body(r)).toMatchObject({ dry_run: true, status: 'paused' });
    expect(r.wroteNothing).toBe(true);
    expect(updateRecurringJournalStatus).not.toHaveBeenCalled();
  });
});
