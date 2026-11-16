/**
 * WP7: GET /api/accounting/bank-reconciliation-report is bounded: bankAccountId must be a UUID (400), each list carries
 * at most `limit` rows (default and maximum REPORT_ROWS_MAX) after its own keyset cursor, and `truncated` says which list had more.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BAD_IDS, UUID_A, callRoute } from '../helpers/apiRouteCall';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import handler, { REPORT_ROWS_MAX } from '../../../pages/api/accounting/bank-reconciliation-report';

const tx = (i: number) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, cursor_date: '2026-01-05', transaction_date: '2026-01-05', description: 'd', reference: null, amount: '-1.00', journal_entry_number: null });
let matchedRows = 0, unmatchedRows = 0;
beforeEach(() => {
  matchedRows = 0; unmatchedRows = 0;
  sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray) => {
    const t = strings.join('?');
    if (t.includes('SELECT account_name')) return [{ account_name: 'Cheque' }];
    if (t.includes('FROM bank_import_batches')) return [];
    if (t.includes("COUNT(*) FILTER")) return [{ matched: matchedRows, unmatched: unmatchedRows }];
    if (t.includes("bt.status = 'matched'")) return Array.from({ length: matchedRows }, (_, i) => tx(i));
    if (t.includes("bt.status = 'imported'")) return Array.from({ length: unmatchedRows }, (_, i) => tx(i));
    return [];
  });
});
const listCalls = () => sqlMock.mock.calls.filter(([s]) => { const t = (s as string[]).join('?'); return t.includes('bt.status =') && !t.includes('COUNT(*)'); });
const body = (r: { body: unknown }) => (r.body as { data: { matchedTransactions: unknown[]; unmatchedTransactions: unknown[]; truncated: { matched: boolean; unmatched: boolean } } }).data;

describe('bank-reconciliation-report', () => {
  it.each(BAD_IDS)('a bankAccountId of %s is a 400 and nothing is queried', async (bad) => {
    expect((await callRoute(handler, { query: { bankAccountId: bad } })).code).toBe(400);
    expect((await callRoute(handler, { query: {} })).code).toBe(400);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('asks each list for LIMIT cap+1 rows from the start by default', async () => {
    await callRoute(handler, { query: { bankAccountId: UUID_A } });
    expect(listCalls()).toHaveLength(2);
    for (const [, ...values] of listCalls()) expect(values).toEqual(expect.arrayContaining([UUID_A, REPORT_ROWS_MAX + 1, null]));
  });

  it('returns at most the cap and says which list was cut', async () => {
    matchedRows = REPORT_ROWS_MAX + 1; unmatchedRows = 3;
    const d = body(await callRoute(handler, { query: { bankAccountId: UUID_A } }));
    expect(d.matchedTransactions).toHaveLength(REPORT_ROWS_MAX);
    expect(d.unmatchedTransactions).toHaveLength(3);
    expect(d.truncated).toEqual({ matched: true, unmatched: false });
  });

  it('a list of exactly the cap is not truncated', async () => {
    matchedRows = REPORT_ROWS_MAX;
    expect(body(await callRoute(handler, { query: { bankAccountId: UUID_A } })).truncated.matched).toBe(false);
  });

  it('a cursor pages each list by (date, id) KEYSET: the predicate compares the row pair, there is no OFFSET', async () => {
    const m = '2026-01-05,00000000-0000-4000-8000-000000000009', u = '2026-02-01,00000000-0000-4000-8000-000000000008';
    await callRoute(handler, { query: { bankAccountId: UUID_A, limit: '100', matchedAfter: m, unmatchedAfter: u } });
    for (const [s0] of listCalls()) {
      const t = (s0 as string[]).join('?');
      expect(t).toContain('(bt.transaction_date, bt.id) > (');
      expect(t).not.toMatch(/OFFSET/);
    }
    const values = listCalls().map(([, ...v]) => v);
    expect(values.some((v) => v.includes('2026-01-05') && v.includes('00000000-0000-4000-8000-000000000009'))).toBe(true);
    expect(values.some((v) => v.includes('2026-02-01') && v.includes('00000000-0000-4000-8000-000000000008'))).toBe(true);
  });

  it('returns the cursor of the last row of each list', async () => {
    matchedRows = 3; unmatchedRows = 0;
    const d = (await callRoute(handler, { query: { bankAccountId: UUID_A } })).body as { data: { nextMatchedAfter: string | null; nextUnmatchedAfter: string | null } };
    expect(d.data.nextMatchedAfter).toBe('2026-01-05,00000000-0000-4000-8000-000000000002');
    expect(d.data.nextUnmatchedAfter).toBeNull();
  });

  it('carries the lists\' TRUE totals, so a client can page to completion or print "first N of M"', async () => {
    matchedRows = 7; unmatchedRows = 3;
    const r = await callRoute(handler, { query: { bankAccountId: UUID_A } });
    expect((r.body as { data: { matchedTotal: number; unmatchedTotal: number } }).data).toMatchObject({ matchedTotal: 7, unmatchedTotal: 3 });
  });

  it.each([
    ['limit above the maximum', { limit: String(REPORT_ROWS_MAX + 1) }],
    ['limit zero', { limit: '0' }],
    ['limit not a number', { limit: 'lots' }],
    ['a cursor that is not date,uuid', { matchedAfter: 'page-two' }],
    ['a cursor with a bad id', { unmatchedAfter: '2026-01-05,not-a-uuid' }],
    ['a cursor with a bad date', { matchedAfter: '2026-13-45,00000000-0000-4000-8000-000000000009' }],
    ['a repeated cursor', { matchedAfter: ['a', 'b'] }],
    ['repeated parameter', { limit: ['10', '20'] }],
  ])('%s is a 400, never a silent page 1', async (_n, extra) => {
    const r = await callRoute(handler, { query: { bankAccountId: UUID_A, ...extra } });
    expect(r.code).toBe(400);
    expect(listCalls()).toHaveLength(0);
  });
});
