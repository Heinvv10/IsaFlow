/**
 * The reconciliation report's data for the PDF, read to completion. GET /bank-reconciliation-report sends at most
 * REPORT_ROWS_MAX (5 000) lines per list; this pages with matchedOffset / unmatchedOffset until both lists are whole.
 * A hard ceiling of RECON_REPORT_MAX_PAGES requests stops a runaway: if it is hit the PDF is given the lists' true
 * totals and prints "first N of M transactions", so a cut list is never presented as the whole.
 */

import { apiFetch, assertOk } from '@/lib/apiFetch';
import type { ReconReportData, ReconTx } from '@/modules/accounting/utils/reconReportPdf';

export const RECON_REPORT_MAX_PAGES = 20;

interface Page extends ReconReportData {
  truncated: { matched: boolean; unmatched: boolean };
  matchedTotal: number;
  unmatchedTotal: number;
}

async function readPage(bankAccountId: string, matchedOffset: number, unmatchedOffset: number): Promise<Page> {
  const params = new URLSearchParams({ bankAccountId, matchedOffset: String(matchedOffset), unmatchedOffset: String(unmatchedOffset) });
  const res = await apiFetch(`/api/accounting/bank-reconciliation-report?${params}`);
  await assertOk(res, 'Could not build the reconciliation report - try again');
  const json = await res.json();
  return (json.data || json) as Page;
}

export async function fetchReconReport(bankAccountId: string): Promise<ReconReportData> {
  const first = await readPage(bankAccountId, 0, 0);
  const matched: ReconTx[] = [...first.matchedTransactions];
  const unmatched: ReconTx[] = [...first.unmatchedTransactions];
  let more = first.truncated;
  let pages = 1;
  while ((more.matched || more.unmatched) && pages < RECON_REPORT_MAX_PAGES) {
    const next = await readPage(bankAccountId, matched.length, unmatched.length);
    matched.push(...next.matchedTransactions);
    unmatched.push(...next.unmatchedTransactions);
    more = next.truncated;
    pages += 1;
  }
  const { truncated: _t, ...rest } = first;
  return {
    ...rest,
    matchedTransactions: matched,
    unmatchedTransactions: unmatched,
    // Totals only matter (and are only passed) when a ceiling left a list short.
    matchedTotal: more.matched ? first.matchedTotal : undefined,
    unmatchedTotal: more.unmatched ? first.unmatchedTotal : undefined,
  };
}
