/**
 * Duplicate Detection Service
 * Detects duplicate supplier invoices via:
 *   1) Exact fingerprint match (confidence 1.0)
 *   2) Fuzzy: same supplier + amount within ±0.5% + date within ±2 days (0.85–0.95)
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DuplicateHit {
  supplierInvoiceId: string;
  invoiceNumber: string;
  totalAmount: number;
  invoiceDate: string;
  confidence: number;
}

type Row = Record<string, unknown>;

// ── Fingerprint ───────────────────────────────────────────────────────────────

/**
 * Compute the duplicate-detection fingerprint — the ONE producer of this
 * string in TypeScript. Its SQL mirror is the expression in migration 670,
 * which is the same expression migration 412's backfill used except for the
 * amount segment.
 *
 * THE AMOUNT IS FIXED-2 BECAUSE THE COLUMN IS. `total_amount` is
 * NUMERIC(15,2), so the SQL side renders 115 as `115.00`, while template
 * interpolation of the JS number renders it as `115`. The two producers
 * therefore disagreed on every amount whose JS rendering is not two decimals,
 * and since 412 backfilled every row that predated it in the SQL format, a
 * lookup from here could not match any of them: the duplicate went undetected
 * and was posted a second time. Migration 670 rewrites the stored column in
 * this format for every row; do not change the shape here without a matching
 * re-backfill.
 */
export function computeFingerprint(
  vatNumber: string | null,
  invoiceNumber: string | null,
  totalAmount: number | null,
): string {
  const vat = vatNumber ?? 'no-vat';
  const inv = invoiceNumber ?? 'no-inv';
  const amt = toColumnScale(totalAmount ?? 0);
  return `${vat}|${inv}|${amt}`.toLowerCase();
}

/**
 * Render an amount exactly as `NUMERIC(15,2)` stores it.
 *
 * NOT `toFixed(2)`. The driver sends the number as its shortest decimal text
 * and PostgreSQL rounds THAT decimal, half away from zero; `toFixed` rounds the
 * binary double instead. They disagree on any `.xx5`: `(1.005).toFixed(2)` is
 * `"1.00"` while `'1.005'::numeric(15,2)` is `1.01`. Nothing constrains the
 * inputs to two decimals — `APInvoiceRowSchema.totalAmount` is a bare
 * `z.number()` — so a CSV cell of `100.005` would otherwise store a fingerprint
 * the column's own value can never reproduce, and the row would be permanently
 * invisible to the exact-match lookup. Rounding the text keeps the two sides
 * equal for every amount, not merely for the ones that happen to be exact.
 */
function toColumnScale(n: number): string {
  const s = String(n);
  // Exponential form (|n| < 1e-6 or >= 1e21) is far outside the column's
  // meaningful range; toFixed agrees with the column on all of it.
  if (!/^-?\d+(\.\d+)?$/.test(s)) return n.toFixed(2);

  const sign = s.startsWith('-') ? '-' : '';
  const [whole, frac = ''] = (sign ? s.slice(1) : s).split('.');
  if (frac.length <= 2) return `${sign}${whole}.${frac.padEnd(2, '0')}`;

  const cents = BigInt(whole + frac.slice(0, 2)) + (frac[2]! >= '5' ? 1n : 0n);
  const digits = cents.toString().padStart(3, '0');
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysDiff(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

function invoiceNumberSimilar(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  // Prefix match (first 4 chars) or suffix match (last 4 chars)
  return la.slice(0, 4) === lb.slice(0, 4) || la.slice(-4) === lb.slice(-4);
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function findDuplicate(
  companyId: string,
  supplierId: string,
  invoiceNumber: string | null,
  totalAmount: number,
  invoiceDate: string,
  vatNumber: string | null,
): Promise<DuplicateHit | null> {
  // Step 1: Exact fingerprint match
  const fingerprint = computeFingerprint(vatNumber, invoiceNumber, totalAmount);

  const exactRows = (await sql`
    SELECT id, invoice_number, total_amount, invoice_date
    FROM supplier_invoices
    WHERE company_id = ${companyId}::uuid
      AND supplier_id = ${supplierId}::uuid
      AND duplicate_fingerprint = ${fingerprint}
    ORDER BY created_at DESC
    LIMIT 1
  `) as Row[];

  if (exactRows[0]) {
    const row = exactRows[0];
    log.info('Exact duplicate fingerprint hit', {
      companyId,
      supplierId,
      fingerprint,
      existingId: row.id,
    }, 'duplicate-detection');
    return {
      supplierInvoiceId: String(row.id),
      invoiceNumber: String(row.invoice_number ?? ''),
      totalAmount: Number(row.total_amount),
      invoiceDate: fmtDate(row.invoice_date),
      confidence: 1.0,
    };
  }

  // Step 2: Fuzzy match — same supplier, amount within ±0.5%, date within ±2 days
  const amtTolerance = totalAmount * 0.005;
  const amtLow = totalAmount - amtTolerance;
  const amtHigh = totalAmount + amtTolerance;

  // Use a 3-day window in SQL (±2 days = 5 days span), then narrow in JS
  const fuzzyRows = (await sql`
    SELECT id, invoice_number, total_amount, invoice_date
    FROM supplier_invoices
    WHERE company_id = ${companyId}::uuid
      AND supplier_id = ${supplierId}::uuid
      AND total_amount BETWEEN ${amtLow} AND ${amtHigh}
      AND invoice_date BETWEEN (${invoiceDate}::date - INTERVAL '2 days')
                           AND (${invoiceDate}::date + INTERVAL '2 days')
    ORDER BY created_at DESC
    LIMIT 5
  `) as Row[];

  for (const row of fuzzyRows) {
    const rowDate = fmtDate(row.invoice_date);
    if (daysDiff(invoiceDate, rowDate) > 2) continue;

    const rowInvNum = row.invoice_number ? String(row.invoice_number) : null;
    const invSimilar = invoiceNumberSimilar(invoiceNumber, rowInvNum);

    const confidence = invSimilar ? 0.95 : 0.85;

    log.info('Fuzzy duplicate candidate found', {
      companyId,
      supplierId,
      existingId: row.id,
      confidence,
    }, 'duplicate-detection');

    return {
      supplierInvoiceId: String(row.id),
      invoiceNumber: rowInvNum ?? '',
      totalAmount: Number(row.total_amount),
      invoiceDate: rowDate,
      confidence,
    };
  }

  return null;
}
