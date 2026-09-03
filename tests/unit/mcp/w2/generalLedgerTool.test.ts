/**
 * `general_ledger` (W2) — a WRAP of `getGeneralLedgerLines`, not a rewrite.
 *
 * The tool's job is the envelope, the cursor and the argument guards. Every
 * figure in the response comes from the service; the SQL and its arithmetic are
 * proved against a real database in generalLedgerStream.integration.test.ts,
 * because a suite that mocks `sql` cannot tell whether the statement runs.
 *
 * What is asserted HERE is what only the tool can get wrong: recomputing a
 * figure the service already owns, paging that loses rows, an envelope whose
 * completeness identity does not hold, and a filter reaching the service
 * unchanged. `balanced` in particular must be PASSED THROUGH — three callers
 * each rolling their own balance check is how 7 of 118 accounts came to be
 * stamped "Difference R0.00 · Balanced".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/generalLedgerStreamService', () => ({
  getGeneralLedgerLines: vi.fn(),
}));

import { getGeneralLedgerLines } from '@/modules/accounting/services/gl/generalLedgerStreamService';
import { generalLedgerTool } from '@/lib/mcp/tools/generalLedger';
import { assertEnvelopeSound } from '@/lib/mcp/contracts';
import type { McpToolContext } from '@/lib/mcp/types';

const CTX = {
  userId: 'u1', companyId: '11111111-1111-4111-8111-111111111111',
  scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a',
} as McpToolContext;

const payload = (r: { content: Array<{ text: string }> }) =>
  JSON.parse(r.content[0]!.text) as Record<string, unknown>;

const line = (over: Record<string, unknown> = {}) => ({
  lineId: 'aaaaaaaa-0000-4000-8000-000000000001',
  journalEntryId: 'bbbbbbbb-0000-4000-8000-000000000001',
  accountId: 'cccccccc-0000-4000-8000-000000000001',
  accountCode: '1101', accountName: 'Trade Debtors', accountType: 'asset',
  normalBalance: 'debit', date: '2026-02-10', entryNumber: 'JE-2026-00001',
  description: 'Invoice INV-1', source: 'auto_invoice',
  debit: 1000, credit: 0, runningBalance: 1000, ...over,
});

const PAGE = {
  lines: [line(), line({ lineId: 'aaaaaaaa-0000-4000-8000-000000000002', debit: 0, credit: 400, runningBalance: 600 })],
  next: null,
  lineCount: 2, totalDebit: 1000, totalCredit: 400, accountCount: 1,
  balanced: null, runningBalanceSuppressed: false,
  openingBalances: { '1101': 0 },
  postedThrough: '2026-02-10T08:00:00.000Z',
};

beforeEach(() => {
  vi.mocked(getGeneralLedgerLines).mockReset().mockResolvedValue(PAGE as never);
});

describe('general_ledger', () => {
  it('serves the service’s own totals and a sound envelope', async () => {
    const res = await generalLedgerTool.handler(
      { period_start: '2026-02-01', period_end: '2026-02-28' }, CTX,
    );
    const body = payload(res as never);
    assertEnvelopeSound(body as never);

    expect(body.rowsTotal).toBe(2);
    expect(body.rowsReturned).toBe(2);
    expect(body.totalDebit).toBe(1000);
    expect(body.totalCredit).toBe(400);
    expect(body.accountCount).toBe(1);
    expect(body.openingBalances).toEqual({ '1101': 0 });
    // Straight from the service. Not recomputed from the rows on this page —
    // which would have said `true` here, because 1000 - 400 over two rows is
    // not what the service was asked about.
    expect(body.balanced).toBeNull();
    expect(body.posted_through).toBe('2026-02-10T08:00:00.000Z');
  });

  it('passes balanced THROUGH rather than deriving it from the page', async () => {
    vi.mocked(getGeneralLedgerLines).mockResolvedValue({
      ...PAGE, balanced: false, totalDebit: 1000, totalCredit: 999,
    } as never);
    const res = await generalLedgerTool.handler(
      { period_start: '2026-02-01', period_end: '2026-02-28' }, CTX,
    );
    expect(payload(res as never).balanced).toBe(false);
  });

  it('forwards every filter to the service, and the company from ctx ONLY', async () => {
    await generalLedgerTool.handler(
      {
        period_start: '2026-02-01', period_end: '2026-02-28',
        account_codes: ['1101', '2110'], account_types: ['asset'],
        sources: ['auto_invoice'], min_amount: 500, search: 'INV',
        company_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        limit: 50,
      },
      CTX,
    );
    const call = vi.mocked(getGeneralLedgerLines).mock.calls[0]![0];
    expect(call.companyId).toBe(CTX.companyId);
    expect(call.accountCodes).toEqual(['1101', '2110']);
    expect(call.accountTypes).toEqual(['asset']);
    expect(call.sources).toEqual(['auto_invoice']);
    expect(call.minAmount).toBe(500);
    expect(call.search).toBe('INV');
    expect(call.limit).toBe(50);
    expect(call.after).toBeNull();
  });

  it('round-trips the cursor: next_cursor decodes to the service’s keyset', async () => {
    vi.mocked(getGeneralLedgerLines).mockResolvedValue({
      ...PAGE,
      next: { accountCode: '1101', date: '2026-02-10', createdKey: '2026-02-10 08:00:00.123456', lineId: 'aaaaaaaa-0000-4000-8000-000000000002' },
      lineCount: 500,
    } as never);
    const first = payload(await generalLedgerTool.handler(
      { period_start: '2026-02-01', period_end: '2026-02-28' }, CTX,
    ) as never);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.truncated).toBe(true);

    await generalLedgerTool.handler(
      { period_start: '2026-02-01', period_end: '2026-02-28', cursor: first.next_cursor },
      CTX,
    );
    // The microsecond precision must survive the round trip. Truncating it to
    // milliseconds re-admits every row inside that millisecond, which is how
    // paging one ledger returned 10,603 lines where 10,460 exist.
    expect(vi.mocked(getGeneralLedgerLines).mock.calls[1]![0].after).toEqual({
      accountCode: '1101', date: '2026-02-10',
      createdKey: '2026-02-10 08:00:00.123456',
      lineId: 'aaaaaaaa-0000-4000-8000-000000000002',
    });
  });

  it('refuses a malformed cursor instead of silently serving page one', async () => {
    const res = await generalLedgerTool.handler(
      { period_start: '2026-02-01', period_end: '2026-02-28', cursor: 'not-a-cursor' }, CTX,
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(vi.mocked(getGeneralLedgerLines)).not.toHaveBeenCalled();
  });

  it('refuses an unknown account_type by NAMING the valid ones', async () => {
    const res = await generalLedgerTool.handler(
      { period_start: '2026-02-01', period_end: '2026-02-28', account_types: ['assets'] }, CTX,
    );
    // Filtering to nothing would read to an agent as "this company has no such
    // accounts" — a wrong answer dressed as a right one.
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res as { content: Array<{ text: string }> }).content[0]!.text).toContain('asset');
    expect(vi.mocked(getGeneralLedgerLines)).not.toHaveBeenCalled();
  });

  it('requires both dates, and refuses one Postgres could not cast', async () => {
    expect(((await generalLedgerTool.handler({ period_start: '2026-02-01' }, CTX)) as { isError?: boolean }).isError).toBe(true);
    const bad = await generalLedgerTool.handler(
      { period_start: 'lol', period_end: '2026-02-28' }, CTX,
    );
    expect((bad as { isError?: boolean }).isError).toBe(true);
    // The guard runs BEFORE the query: a read tool has no savepoint, so a cast
    // error raised after the query aborts the whole request transaction.
    expect(vi.mocked(getGeneralLedgerLines)).not.toHaveBeenCalled();
  });

  it('detail "summary" serves totals and NO rows', async () => {
    const body = payload(await generalLedgerTool.handler(
      { period_start: '2026-02-01', period_end: '2026-02-28', detail: 'summary' }, CTX,
    ) as never);
    assertEnvelopeSound(body as never);
    expect(body.rows).toEqual([]);
    expect(body.rowsTotal).toBe(2);
    expect(body.totalDebit).toBe(1000);
    expect(body.truncated).toBe(false);
  });

  it('says when the running balance was suppressed rather than serving nulls silently', async () => {
    vi.mocked(getGeneralLedgerLines).mockResolvedValue({
      ...PAGE,
      runningBalanceSuppressed: true,
      lines: [line({ runningBalance: null })],
      lineCount: 1,
    } as never);
    const body = payload(await generalLedgerTool.handler(
      { period_start: '2026-02-01', period_end: '2026-02-28', sources: ['auto_invoice'] }, CTX,
    ) as never);
    expect(body.runningBalanceSuppressed).toBe(true);
    expect((body.rows as Array<{ runningBalance: unknown }>)[0]!.runningBalance).toBeNull();
  });
});
