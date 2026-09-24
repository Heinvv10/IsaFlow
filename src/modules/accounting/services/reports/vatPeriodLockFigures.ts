/**
 * The figures a VAT period lock records: output tax, input tax, net VAT and the
 * `posted_through` they were computed at — read from the same VAT201 report
 * `vat_status` and `vat201_export` use.
 *
 * One function so the MCP `lock_vat_period` tool and the REST route
 * (pages/api/accounting/vat-period-locks.ts) record the SAME numbers for the
 * same ledger. The report is returned too: both callers refuse a period whose
 * 15% check fails unless told to force it, and a dry run shows the rate check.
 *
 * Takes the EXCLUSIVE VAT-lock advisory key before it reads anything, so no
 * post can land between this snapshot and the lock INSERT that records it
 * (both run in the caller's transaction; see journalVatLockGuard).
 */
import { getVat201Report, type Vat201Report } from './vat201ReportService';
import type { VatLockFigures } from './vatPeriodLockService';
import { takeVatLockExclusive } from '../gl/journalVatLockGuard';

export interface VatLockSnapshot {
  figures: VatLockFigures;
  report: Vat201Report;
}

export async function computeVatLockFigures(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<VatLockSnapshot> {
  await takeVatLockExclusive(companyId);
  const report = await getVat201Report(companyId, periodStart, periodEnd, { detail: 'summary' });
  return {
    figures: {
      outputTax: report.totals.outputTax,
      inputTax: report.totals.inputTax,
      netVat: report.totals.netVat,
      postedThrough: report.postedThrough,
    },
    report,
  };
}
