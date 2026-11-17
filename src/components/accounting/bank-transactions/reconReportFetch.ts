/**
 * The reconciliation report's data for the PDF, read to completion. GET /bank-reconciliation-report sends at most
 * REPORT_ROWS_MAX (5 000) lines per list; this pages with the keyset cursors (matchedAfter / unmatchedAfter) until both lists are whole: a line inserted between pages
 * cannot repeat or skip a row.
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
  nextMatchedAfter: string | null;
  nextUnmatchedAfter: string | null;
}

async function readPage(bankAccountId: string, matchedAfter: string | null, unmatchedAfter: string | null): Promise<Page> {
  const params = new URLSearchParams({ bankAccountId });
  if (matchedAfter) params.set('matchedAfter', matchedAfter);
  if (unmatchedAfter) params.set('unmatchedAfter', unmatchedAfter);
  const res = await apiFetch(`/api/accounting/bank-reconciliation-report?${params}`);
  await assertOk(res, 'Could not build the reconciliation report - try again');
  const json = await res.json();
  return (json.data || json) as Page;
}

export async function fetchReconReport(bankAccountId: string): Promise<ReconReportData> {
  const first = await readPage(bankAccountId, null, null);
  const matched: ReconTx[] = [...first.matchedTransactions];
  const unmatched: ReconTx[] = [...first.unmatchedTransactions];
  let more = first.truncated;
  let mAfter = first.nextMatchedAfter;
  let uAfter = first.nextUnmatchedAfter;
  let pages = 1;
  while ((more.matched || more.unmatched) && pages < RECON_REPORT_MAX_PAGES) {
    // A list already whole keeps its last cursor, so asking again returns nothing of it (never a repeat from the start).
    const next = await readPage(bankAccountId, mAfter, uAfter);
    matched.push(...next.matchedTransactions);
    unmatched.push(...next.unmatchedTransactions);
    more = next.truncated;
    mAfter = next.nextMatchedAfter ?? mAfter;
    uAfter = next.nextUnmatchedAfter ?? uAfter;
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
