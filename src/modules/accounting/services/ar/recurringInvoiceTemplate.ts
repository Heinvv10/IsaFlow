/**
 * Recurring invoice TEMPLATE parsing and totals.
 *
 * Split from recurringInvoiceService so the run path stays readable and the
 * pure parts — which is all of this — are unit-testable without a database.
 */

import type { DbRow } from '@/lib/neon';

/** Raised when a stored template cannot be turned into a well-formed invoice. */
export class RecurringInvoiceTemplateError extends Error {
  readonly code = 'RECURRING_INVOICE_TEMPLATE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'RecurringInvoiceTemplateError';
  }
}

export interface TemplateLine {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

/**
 * Parse and VALIDATE the stored line_items JSON.
 *
 * Every element is checked rather than cast: `line_items` is unvalidated JSONB
 * written by createRecurringInvoice, the PUT route and the Sage import, and
 * templates predating the current input guards are still in the table. An
 * element missing unitPrice used to reach Postgres as NaN and come back as
 * `invalid input syntax for type numeric`, and a quantity of 0 or null was
 * silently coerced to 1 — which put the invoice detail out of agreement with
 * the receivable the GL was debited with.
 */
export function parseLineItems(recurringId: string, raw: unknown): TemplateLine[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RecurringInvoiceTemplateError(
        `Recurring invoice ${recurringId} has unreadable line_items JSON`,
      );
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new RecurringInvoiceTemplateError(
      `Recurring invoice ${recurringId} has no line items — nothing to generate`,
    );
  }
  return parsed.map((entry, i) => {
    const li = (entry ?? {}) as Record<string, unknown>;
    const description = typeof li.description === 'string' ? li.description.trim() : '';
    const quantity = Number(li.quantity);
    // Nullish is checked before Number(): Number(null) is 0, so a line that
    // simply has no price would otherwise be billed at zero.
    const unitPrice = li.unitPrice == null ? Number.NaN : Number(li.unitPrice);
    if (!description) {
      throw new RecurringInvoiceTemplateError(
        `Recurring invoice ${recurringId} line ${i + 1}: description is required`,
      );
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new RecurringInvoiceTemplateError(
        `Recurring invoice ${recurringId} line ${i + 1} ("${description}"): quantity must be a positive number`,
      );
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new RecurringInvoiceTemplateError(
        `Recurring invoice ${recurringId} line ${i + 1} ("${description}"): unit price must be zero or more`,
      );
    }
    return { description, quantity, unitPrice, amount: round2(quantity * unitPrice) };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function deriveTotals(lines: TemplateLine[], taxRate: number): {
  subtotal: number; taxAmount: number; totalAmount: number;
} {
  const subtotal = round2(lines.reduce((s, li) => s + li.amount, 0));
  const taxAmount = round2(subtotal * (taxRate / 100));
  return { subtotal, taxAmount, totalAmount: round2(subtotal + taxAmount) };
}

/**
 * Refuse when the stored aggregate and the lines disagree.
 *
 * Tolerance is one cent per line: createRecurringInvoice sums unrounded line
 * values and rounds once, while each invoice line is rounded to cents on its
 * own, so a long template can legitimately differ by accumulated half-cents.
 * Anything wider means the template's totals were edited without its lines (or
 * the reverse) and the operator has to say which is right.
 */
export function assertAggregateAgrees(
  recurringId: string,
  totals: { subtotal: number; taxAmount: number; totalAmount: number },
  ri: DbRow,
  lineCount: number,
): void {
  const tolerance = 0.01 * lineCount;
  const stored = Number(ri.total_amount);
  if (Number.isFinite(stored) && Math.abs(stored - totals.totalAmount) > tolerance) {
    throw new RecurringInvoiceTemplateError(
      `Recurring invoice ${recurringId} totals disagree with its lines: `
      + `template says ${stored.toFixed(2)}, its ${lineCount} line(s) come to `
      + `${totals.totalAmount.toFixed(2)}. Re-save the template before running it.`,
    );
  }
}

