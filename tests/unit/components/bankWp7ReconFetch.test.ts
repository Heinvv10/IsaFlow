/**
 * WP7: the reconciliation PDF reads the report to completion (keyset cursors), and only if a hard
 * ceiling is hit does it carry the lists' totals so the PDF prints "first N of M transactions".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { fetchReconReport, RECON_REPORT_MAX_PAGES } from '@/components/accounting/bank-transactions/reconReportFetch';
import { countLabel } from '@/modules/accounting/utils/reconReportPdf';

const PAGE = 3; // rows per page in this fake server
const tx = (i: number) => ({ date: '2026-01-01', description: `t${i}`, amount: -1 });

/** A server holding `matched` and `unmatched` lines that answers PAGE of each per request, as the real one does at 5000. */
function serve(matched: number, unmatched: number) {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const q = new URL(String(url), 'http://x').searchParams;
    const at = (name: string) => (q.get(name) ? Number(q.get(name)!.split(',')[1]) + 1 : 0); // cursor "date,<index>" -> next index
    const mo = at('matchedAfter'), uo = at('unmatchedAfter');
    const cur = (list: unknown[], from: number) => (list.length ? `2026-01-01,${from + list.length - 1}` : null);
    const m = Array.from({ length: Math.max(0, Math.min(PAGE, matched - mo)) }, (_, i) => tx(mo + i));
    const u = Array.from({ length: Math.max(0, Math.min(PAGE, unmatched - uo)) }, (_, i) => tx(uo + i));
    return new Response(JSON.stringify({ success: true, data: {
      bankAccountName: 'Cheque', statementDate: '2026-01-31', matchedTransactions: m, unmatchedTransactions: u,
      truncated: { matched: matched > mo + PAGE, unmatched: unmatched > uo + PAGE }, matchedTotal: matched, unmatchedTotal: unmatched,
      nextMatchedAfter: cur(m, mo), nextUnmatchedAfter: cur(u, uo),
    } }), { status: 200 });
  });
}
const requests = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u));

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('fetchReconReport', () => {
  it('a short report is one request', async () => {
    serve(2, 1);
    const r = await fetchReconReport('bank-1');
    expect(requests()).toHaveLength(1);
    expect(r.matchedTransactions).toHaveLength(2);
    expect(r.matchedTotal).toBeUndefined();
  });

  it('pages each list from its own offset until both are whole, with no gap or repeat', async () => {
    serve(8, 4); // matched needs 3 pages, unmatched 2
    const r = await fetchReconReport('bank-1');
    expect(r.matchedTransactions.map((t) => t.description)).toEqual(Array.from({ length: 8 }, (_, i) => `t${i}`));
    expect(r.unmatchedTransactions.map((t) => t.description)).toEqual(Array.from({ length: 4 }, (_, i) => `t${i}`));
    expect(requests()).toHaveLength(3);
    expect(requests()[1]).toContain('matchedAfter=2026-01-01%2C2');
    expect(requests()[1]).toContain('unmatchedAfter=2026-01-01%2C2');
    expect(r.matchedTotal).toBeUndefined(); // complete: nothing to say
  });

  it('a list that is whole keeps its last cursor while the other pages: never restarted from the top (no repeats)', async () => {
    serve(10, 3); // unmatched is whole after page 1; matched needs 4 pages, and the later unmatched pages are empty
    const r = await fetchReconReport('bank-1');
    expect(r.matchedTransactions).toHaveLength(10);
    expect(r.unmatchedTransactions.map((t) => t.description)).toEqual(['t0', 't1', 't2']);
    serve(3, 10); // and the other way round
    const r2 = await fetchReconReport('bank-1');
    expect(r2.matchedTransactions.map((t) => t.description)).toEqual(['t0', 't1', 't2']);
    expect(r2.unmatchedTransactions).toHaveLength(10);
  });

  it('at the hard ceiling the report carries the TRUE totals (the PDF says "first N of M")', async () => {
    serve(PAGE * RECON_REPORT_MAX_PAGES + 50, 2);
    const r = await fetchReconReport('bank-1');
    expect(requests()).toHaveLength(RECON_REPORT_MAX_PAGES);
    expect(r.matchedTransactions).toHaveLength(PAGE * RECON_REPORT_MAX_PAGES);
    expect(r.matchedTotal).toBe(PAGE * RECON_REPORT_MAX_PAGES + 50);
    expect(r.unmatchedTotal).toBeUndefined(); // that list is whole
  });

  it('a failed page fails the report (no half-built PDF)', async () => {
    serve(8, 4);
    vi.mocked(apiFetch).mockImplementationOnce(async () => new Response('{}', { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 500 }));
    await expect(fetchReconReport('bank-1')).rejects.toBeTruthy();
  });
});

describe('countLabel', () => {
  it('says "first N of M transactions" only when the list was cut', () => {
    expect(countLabel(5000, 7312)).toBe('first 5000 of 7312 transactions');
    expect(countLabel(3, undefined)).toBe('3 transactions');
    expect(countLabel(1, 1)).toBe('1 transaction');
    expect(countLabel(0)).toBe('0 transactions');
  });
});
