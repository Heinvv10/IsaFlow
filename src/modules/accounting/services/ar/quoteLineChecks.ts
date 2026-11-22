/**
 * A quote's lines checked before any write (W1, migration 874), and the request's `amountsAre`. Split from quoteService
 * (the 300-line cap); quoteService re-exports LineValidationError and assertValidLines.
 */
import { shownPosition } from '@/lib/lineNumbers';
import { assertLineAccountIds } from './invoiceLineCodingGuard';
import type { AmountsAre } from './invoiceLineVatPricing';
import { toColumnCents } from './invoiceLineAmount';

interface QuoteCheckedLine { quantity: number; unitPrice: number; taxRate?: unknown; accountId?: string | null; lineNo?: unknown }

/** Thrown for W1 line-validation failures — handlers map it to HTTP 400. Re-exported by quoteService. */
export class LineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineValidationError';
  }
}

/** Why a supplied legacy rate is refused, or null. An omitted rate (undefined / null) is not refused. */
export function taxRateProblem(rate: unknown): string | null {
  if (rate === undefined || rate === null) return null;
  const n = typeof rate === 'number' || (typeof rate === 'string' && rate.trim() !== '') ? Number(rate) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? null : 'VAT rate must be a number from 0 to 100';
}

/** The `amountsAre` a request names; absent is 'exclusive'. */
export function quoteAmountsAre(v: unknown): AmountsAre {
  if (v === undefined || v === null) return 'exclusive';
  if (v === 'exclusive' || v === 'inclusive') return v;
  throw new LineValidationError('amountsAre must be "exclusive" or "inclusive"');
}

/**
 * W1 (P2.1): negative quantities/prices produced negative documents server-side
 * (the July-4 audit created a -R115 invoice live). Zero-quantity lines are
 * also meaningless on a quote. Throws before any SQL runs. A line is named by position, never by description (error capture).
 */
export async function assertValidLines(companyId: string, lines: readonly QuoteCheckedLine[]): Promise<void> {
  for (const [i, l] of (lines || []).entries()) {
    const n = shownPosition(l.lineNo, i + 1); // the number on the form, which may have dropped blank lines
    if (!(Number(l.quantity) > 0) || !Number.isFinite(Number(l.quantity))) throw new LineValidationError(`Line ${n}: quantity must be positive`);
    if (!Number.isFinite(Number(l.unitPrice))) throw new LineValidationError(`Line ${n}: unit price must be a number`);
    if (Number(l.unitPrice) < 0) throw new LineValidationError(`Line ${n}: unit price cannot be negative`);
    // The columns' bounds (quantity numeric(10,2), unit_price numeric(15,2)), as the invoice create checks them.
    if (Number(l.quantity) >= 1e8) throw new LineValidationError(`Line ${n}: quantity must be below 100 000 000`);
    // Stored to two places, as an invoice's: 0.004 would store a line of quantity 0 and amount 0 (priceDraftLines refuses it too).
    if (toColumnCents(Number(l.quantity)) <= 0) throw new LineValidationError(`Line ${n}: quantity must be at least 0.01`);
    if (Number(l.unitPrice) >= 1e13) throw new LineValidationError(`Line ${n}: unit price must be below 10 000 000 000 000`);
    const rateProblem = taxRateProblem(l.taxRate);
    if (rateProblem) throw new LineValidationError(`Line ${n}: ${rateProblem}`);
  }
  await assertLineAccountIds(companyId, (lines || []).map((l) => l.accountId)); // conversion posts to them (mig 874)
}

