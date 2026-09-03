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
import { getVatPeriodLock, type VatPeriodLock } from './vatPeriodLockService';

export type Vat201ExportFormat = 'sars_payload' | 'csv';

export interface Vat201Export {
  periodStart: string;
  periodEnd: string;
  format: Vat201ExportFormat;
  /** Present when format is `sars_payload`. */
  payload?: SARSPayload & { totalOutputVAT: number; totalInputVAT: number; netVAT: number };
  /** Present when format is `csv`. */
  csv?: string;
  /** The 15% tie-out, carried through so nobody files a return that fails it unknowingly. */
  rateCheck: Vat201Report['rateCheck'];
  /** The lock, when the period has been filed. */
  lock: VatPeriodLock | null;
  /**
   * Set when the period is locked AND the ledger no longer computes what was
   * filed. This is the whole reason the lock stores its figures.
   */
  driftSinceLock: { outputTax: number; inputTax: number; netVat: number } | null;
  postedThrough: string;
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

function toCsv(report: Vat201Report): string {
  const header = ['box', 'label', 'direction', 'vat_type', 'base', 'tax', 'implied_tax_at_15pct', 'variance'];
  const lines = [header.map(csvVal).join(',')];
  for (const b of report.boxes) {
    lines.push([b.box, b.label, b.direction, b.vatType, b.base, b.tax, b.impliedTax, b.variance].map(csvVal).join(','));
  }
  lines.push([ 'TOTALS', 'Output tax (box 4) / Input tax (box 19) / Net (box 20)', '', '',
    report.totals.standardRatedSupplies, report.totals.outputTax, report.totals.inputTax, report.totals.netVat,
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
  const [report, company, lock] = await Promise.all([
    getVat201Report(companyId, periodStart, periodEnd, { detail: 'summary' }),
    getCompany(companyId),
    getVatPeriodLock(companyId, periodStart, periodEnd),
  ]);

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
    lock,
    driftSinceLock,
    postedThrough: report.postedThrough,
  };

  if (format === 'csv') return { ...base, csv: toCsv(report) };

  return {
    ...base,
    payload: buildVAT201Payload({
      taxPeriod: taxPeriod(periodEnd),
      vatNumber: company?.vatNumber ?? '',
      companyName: company?.name ?? '',
      outputVATStandard: boxValue(report, '1', 'tax') + boxValue(report, '1A', 'tax'),
      outputVATZeroRated: boxValue(report, '2', 'tax') + boxValue(report, '2A', 'tax'),
      outputVATExempt: boxValue(report, '3', 'tax'),
      inputVATCapitalGoods: boxValue(report, '14', 'tax'),
      inputVATOther: boxValue(report, '15', 'tax') + boxValue(report, '14A/15A', 'tax'),
      adjustments: boxValue(report, '16', 'tax') + boxValue(report, '17', 'tax') + boxValue(report, '18', 'tax'),
    }),
  };
}
