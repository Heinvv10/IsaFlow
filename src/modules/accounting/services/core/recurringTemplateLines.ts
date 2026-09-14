/**
 * Template line normalisation and the header totals a recurring document is
 * written with.
 *
 * Split out of recurringTransactionInvoices.ts only to keep that file under the
 * 300-line cap; the rules are unchanged.
 */

import { RecurringTemplateTotalsMismatchError } from './recurringTransactionErrors';

interface TemplateLine {
  description?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  taxRate?: unknown;
  lineTotal?: unknown;
  amount?: unknown;
  accountId?: unknown;
  glAccountId?: unknown;
}

export interface NormalisedLine {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  lineTotal: number;
  taxAmount: number;
  glAccountId: string | null;
}

/**
 * The template's `lines` array, normalised. Absent or empty is allowed: the
 * templates in production predate the field and carry only the aggregate, and
 * refusing those would stop every existing recurring run. When lines ARE given
 * — the shape the create modal documents — they are written, so the document
 * has detail behind it rather than a bare header.
 */
export function normaliseLines(data: Record<string, unknown>): NormalisedLine[] {
  if (!Array.isArray(data.lines)) return [];
  return (data.lines as TemplateLine[]).map((l) => {
    const quantity = Number(l.quantity ?? 1);
    const unitPrice = Number(l.unitPrice ?? 0);
    const taxRate = Number(l.taxRate ?? 0);
    const lineTotal = Number(l.lineTotal ?? l.amount ?? quantity * unitPrice);
    const account = String(l.accountId ?? l.glAccountId ?? '');
    return {
      description: String(l.description ?? ''),
      quantity,
      unitPrice,
      taxRate,
      lineTotal,
      // taxRate is a percentage, so tax is lineTotal * rate / 100; the divide
      // by 100 after rounding the product is that, rounded to two decimals.
      taxAmount: Math.round(lineTotal * taxRate) / 100,
      glAccountId: account || null,
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface HeaderTotals { subtotal: number; taxAmount: number; totalAmount: number }

/**
 * The header the document is written with.
 *
 * WHEN THE TEMPLATE HAS LINES, THE LINES ARE THE DOCUMENT and the header is
 * derived from them — the aggregate is not copied across. The GL is posted from
 * the header (subtotal / tax_amount / total_amount) while the detail the
 * customer or supplier sees is the lines, so copying an aggregate that
 * disagrees produces a document that is wrong in one of those two places with
 * nothing surfacing it: a template whose lines came to R100 minted a header
 * reading R9 999 subtotal / R11 499 total against R100 of detail.
 *
 * The stored aggregate is still CHECKED, not merely ignored, so a template
 * whose totals were edited without its lines (or the reverse) is refused rather
 * than silently re-priced. Same rule, same tolerance and same reasoning as
 * recurringInvoiceService's deriveTotals/assertAggregateAgrees, which the AR
 * recurring-invoice path has used since its own round.
 *
 * Templates that predate the `lines` field carry only the aggregate; those keep
 * running on it, because refusing them would stop every existing schedule.
 */
export function headerTotals(
  templateId: string,
  data: Record<string, unknown>,
  lines: NormalisedLine[],
): HeaderTotals {
  const stored: HeaderTotals = {
    subtotal: Number(data.subtotal || 0),
    taxAmount: Number(data.vatAmount || 0),
    totalAmount: Number(data.totalAmount || 0),
  };
  if (lines.length === 0) return stored;

  const derived: HeaderTotals = {
    subtotal: round2(lines.reduce((t, l) => t + l.lineTotal, 0)),
    taxAmount: round2(lines.reduce((t, l) => t + l.taxAmount, 0)),
    totalAmount: 0,
  };
  derived.totalAmount = round2(derived.subtotal + derived.taxAmount);

  // One cent per line, capped at R1.00: each line is rounded to cents on its
  // own while the stored aggregate was rounded once, so a wide template drifts
  // legitimately by cents — but a 500-line template must not quietly tolerate
  // five rand. Subtotal, tax and total are compared SEPARATELY: a wrong
  // subtotal with a compensating tax has the right total and is still broken.
  const tolerance = Math.min(0.01 * lines.length, 1);
  const checks: [string, number, number][] = [
    ['subtotal', stored.subtotal, derived.subtotal],
    ['tax', stored.taxAmount, derived.taxAmount],
    ['total', stored.totalAmount, derived.totalAmount],
  ];
  for (const [label, storedValue, derivedValue] of checks) {
    // Zero reads as "unset" here, not as "the template says zero": these three
    // keys are optional on templateData and default to 0 above, so comparing a
    // missing aggregate against real lines would refuse every line-only
    // template. A NON-zero disagreement is what the operator has to resolve.
    if (storedValue === 0 || !Number.isFinite(storedValue)) continue;
    if (Math.abs(storedValue - derivedValue) <= tolerance) continue;
    throw new RecurringTemplateTotalsMismatchError(
      templateId,
      `Recurring template ${templateId} totals disagree with its lines: template `
      + `${label} is ${storedValue.toFixed(2)}, its ${lines.length} line(s) come to `
      + `${derivedValue.toFixed(2)}. Re-save the template before running it.`,
    );
  }
  return derived;
}
