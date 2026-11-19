/**
 * The VAT201 as something you can hand to SARS.
 *
 * WRAPS `sarsEfilingService#buildVAT201Payload`, which already emits the field
 * codes and was not reachable outside the UI. It is fed from the JOURNAL-DERIVED
 * boxes (`vat201ReportService`) rather than from the invoice tables, so the
 * exported return is the same one the 15% check was run against. Exporting a
 * different arithmetic from the one that was checked would make the check
 * decorative.
 *
 * A LOCKED PERIOD EXPORTS ITS LOCK, NOT TODAY'S LEDGER. If the period has been
 * filed, the export carries the figures recorded at filing and says what the
 * ledger now computes beside them. That difference is the finding — a return
 * re-derived after somebody back-dated a journal into a filed period is not
 * "an updated return", it is evidence.
 */
import { csvVal } from '@/lib/csv';
import { getCompany } from '../core/companyService';
import { buildVAT201Payload, type SARSPayload } from './sarsEfilingService';
import { getVat201Report, type Vat201Report } from './vat201ReportService';
import { getNilRatedSupplies } from './vat201NilRatedSupplies';
import { rateCheckForFiling, type FilingRateCheck } from './vat201RateCheck';
import { getVatPeriodLock, type VatPeriodLock } from './vatPeriodLockService';
import { getVatExceptions } from './vatExceptionsService';
import { vatGateExceptionCounts, type VatGateExceptionCounts } from './vatGateOverrideService';

export type Vat201ExportFormat = 'sars_payload' | 'csv';

export interface Vat201Export {
  periodStart: string;
  periodEnd: string;
  format: Vat201ExportFormat;
  /** Present when format is `sars_payload`. */
  payload?: SARSPayload & { totalOutputVAT: number; totalInputVAT: number; netVAT: number };
  /** Present when format is `csv`. */
  csv?: string;
  /** The report's per-box 15% tie-out: a diagnostic, measured before the nil-rated give-back. */
  rateCheck: Vat201Report['rateCheck'];
  /**
   * The 15% verdict by the function the lock and finalise gates judge with (vat201RateCheck.rateCheckForFiling):
   * output tax against the taxed output base after zero-rated/exempt supplies on taxed journals are given back. On
   * the ledger as read now, locked period or not, with no lock taken; the gates recompute it under the VAT lock.
   */
  filingRateCheck: FilingRateCheck;
  /** The lock, when the period has been filed. */
  lock: VatPeriodLock | null;
  /**
   * Set when the period is locked AND the ledger no longer computes what was
   * filed. This is the whole reason the lock stores its figures.
   */
  driftSinceLock: { outputTax: number; inputTax: number; netVat: number } | null;
  postedThrough: string;
  /**
   * WARNING ONLY — never a refusal. getVatExceptions' blocking exceptions,
   * carried through so a filer sees them beside the export; unlike ISV filing
   * (sarsEfilingSubmissionService) and lock/mark-submitted
   * (vatGateOverrideService), the export itself never blocks and needs no
   * override.
   */
  blockingExceptions: VatGateExceptionCounts;
  /**
   * WARNING ONLY, NOT in blockingExceptions (Hein, 2026-09-27): supplier
   * bills with no tax rate, or a rate but zero VAT — can only mean less
   * input VAT was claimed than the bill's own rate supports, never more.
   */
  billTaxCodeWarningCount: number;
  billTaxCodeWarningPotentialVat: number;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A SARS tax period is the period end as YYYYMM. */
function taxPeriod(periodEnd: string): string {
  return periodEnd.slice(0, 7).replace('-', '');
}

function boxValue(report: Vat201Report, box: string, field: 'base' | 'tax'): number {
  return r2(report.boxes.filter((b) => b.box === box).reduce((s, b) => s + b[field], 0));
}

/** Tax in every box of `direction` that is NOT one of `named`: whatever the payload has no field of its own for. */
function taxOutside(report: Vat201Report, direction: 'output' | 'input', named: readonly string[]): number {
  return r2(report.boxes.filter((b) => b.direction === direction && !named.includes(b.box)).reduce((s, b) => s + b.tax, 0));
}

function toCsv(report: Vat201Report, filing: FilingRateCheck): string {
  const header = ['box', 'label', 'direction', 'vat_type', 'base', 'tax', 'implied_tax_at_15pct', 'variance'];
  const lines = [header.map(csvVal).join(',')];
  for (const b of report.boxes) {
    lines.push([b.box, b.label, b.direction, b.vatType, b.base, b.tax, b.impliedTax, b.variance].map(csvVal).join(','));
  }
  lines.push([ 'TOTALS', 'Output tax (box 4) / Input tax (box 19) / Net (box 20)', '', '',
    report.totals.standardRatedSupplies, report.totals.outputTax, report.totals.inputTax, report.totals.netVat,
  ].map(csvVal).join(','));
  // The rows above are the per-box diagnostic. A reader of the csv alone must see the verdict the gates judge too:
  // one labelled row like TOTALS, the taxed output base in `base`, 15% of it in `implied_tax_at_15pct`.
  lines.push([
    'FILING_CHECK',
    `15% check the lock and finalise gates judge, on the ledger as read now: ${filing.ties ? 'ties' : 'FAILS'}; `
      + `${filing.nilRatedGivenBack.toFixed(2)} of zero-rated or exempt supplies on taxed journals given back; `
      + `input tax over-claimed by ${filing.inputVariance.toFixed(2)}`,
    'output', '', filing.taxedOutputBase, report.totals.outputTax,
    r2(report.totals.outputTax - filing.outputVariance), filing.outputVariance,
  ].map(csvVal).join(','));
  // Unplaced VAT is part of the export, not a footnote. A reader taking the
  // CSV to a filing needs to see what the boxes could not account for.
  for (const ex of report.excludedRows) {
    lines.push(['EXCLUDED', ex.detail, '', ex.reason, '', ex.amount, '', ''].map(csvVal).join(','));
  }
  return lines.join('\n');
}

export async function exportVat201(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  format: Vat201ExportFormat = 'sars_payload',
): Promise<Vat201Export> {
  const [report, company, lock, exceptionsReport, nilRated] = await Promise.all([
    getVat201Report(companyId, periodStart, periodEnd, { detail: 'summary' }),
    getCompany(companyId),
    getVatPeriodLock(companyId, periodStart, periodEnd),
    getVatExceptions(companyId, periodStart, periodEnd),
    getNilRatedSupplies(companyId, periodStart, periodEnd),
  ]);
  const blockingExceptions = vatGateExceptionCounts(exceptionsReport);
  // A failed nil-rated read fails the export whole, as any of the reads above does (never a missing verdict).
  const filing = rateCheckForFiling(report, nilRated);

  const driftSinceLock = lock && (
    r2(lock.outputTax) !== report.totals.outputTax
    || r2(lock.inputTax) !== report.totals.inputTax
  )
    ? {
        outputTax: r2(report.totals.outputTax - lock.outputTax),
        inputTax: r2(report.totals.inputTax - lock.inputTax),
        netVat: r2(report.totals.netVat - lock.netVat),
      }
    : null;

  const base: Omit<Vat201Export, 'payload' | 'csv'> = {
    periodStart,
    periodEnd,
    format,
    rateCheck: report.rateCheck,
    filingRateCheck: filing,
    lock,
    driftSinceLock,
    postedThrough: report.postedThrough,
    blockingExceptions,
    billTaxCodeWarningCount: exceptionsReport.billTaxCodeWarningCount,
    billTaxCodeWarningPotentialVat: exceptionsReport.billTaxCodeWarningPotentialVat,
  };

  if (format === 'csv') return { ...base, csv: toCsv(report, filing) };

  return {
    ...base,
    // The payload's net must be the report's net. Output boxes the payload has no field for (12: domestic
    // reverse charge, imported services; unmapped types) go in `outputVATOther`, and input boxes beyond
    // 14 / 15 / 14A-15A (16, 17, 18, unmapped) are `adjustments`; a mismatch refuses the export.
    payload: buildVAT201Payload({
      taxPeriod: taxPeriod(periodEnd),
      vatNumber: company?.vatNumber ?? '',
      companyName: company?.name ?? '',
      outputVATStandard: boxValue(report, '1', 'tax') + boxValue(report, '1A', 'tax'),
      outputVATZeroRated: boxValue(report, '2', 'tax') + boxValue(report, '2A', 'tax'),
      outputVATExempt: boxValue(report, '3', 'tax'),
      inputVATCapitalGoods: boxValue(report, '14', 'tax'),
      inputVATOther: boxValue(report, '15', 'tax') + boxValue(report, '14A/15A', 'tax'),
      adjustments: taxOutside(report, 'input', ['14', '15', '14A/15A']),
      outputVATOther: taxOutside(report, 'output', ['1', '1A', '2', '2A', '3']),
    }, { expectedNetVat: report.totals.netVat }),
  };
}
