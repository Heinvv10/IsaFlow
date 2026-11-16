/**
 * WP7: GET /api/accounting/bank-reconciliation-report is bounded: bankAccountId must be a UUID (400), each list carries
 * at most `limit` rows (default and maximum REPORT_ROWS_MAX) from its own offset, and `truncated` says which list had more.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BAD_IDS, UUID_A, callRoute } from '../helpers/apiRouteCall';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import handler, { REPORT_OFFSET_MAX, REPORT_ROWS_MAX } from '../../../pages/api/accounting/bank-reconciliation-report';

const tx = (i: number) => ({ id: `t${i}`, transaction_date: '2026-01-05', description: 'd', reference: null, amount: '-1.00', journal_entry_number: null });
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

  it('asks each list for LIMIT cap+1 rows from offset 0 by default', async () => {
    await callRoute(handler, { query: { bankAccountId: UUID_A } });
    expect(listCalls()).toHaveLength(2);
    for (const [, ...values] of listCalls()) expect(values).toEqual(expect.arrayContaining([UUID_A, REPORT_ROWS_MAX + 1, 0]));
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

  it('limit and per-list offsets page the lists', async () => {
    await callRoute(handler, { query: { bankAccountId: UUID_A, limit: '100', matchedOffset: '200', unmatchedOffset: '300' } });
    const values = listCalls().map(([, ...v]) => v);
    expect(values.some((v) => v.includes(101) && v.includes(200))).toBe(true);
    expect(values.some((v) => v.includes(101) && v.includes(300))).toBe(true);
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
    ['matchedOffset above the bound', { matchedOffset: String(REPORT_OFFSET_MAX + 1) }],
    ['unmatchedOffset above the bound', { unmatchedOffset: String(REPORT_OFFSET_MAX + 1) }],
    ['negative offset', { matchedOffset: '-1' }],
    ['repeated parameter', { limit: ['10', '20'] }],
  ])('%s is a 400, never a silent page 1', async (_n, extra) => {
    const r = await callRoute(handler, { query: { bankAccountId: UUID_A, ...extra } });
    expect(r.code).toBe(400);
    expect(listCalls()).toHaveLength(0);
  });
});
