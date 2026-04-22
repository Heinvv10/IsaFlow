/**
 * Expectation Engine Service — PRD-05 Phase 6
 * Learns supplier billing cadence and upserts supplier_expectations.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SupplierExpectation {
  id: string;
  companyId: string;
  supplierId: string;
  cadence: 'monthly' | 'quarterly' | 'annual' | 'irregular';
  expectedDayOfMonth: number | null;
  expectedAmount: number | null;
  amountStddev: number | null;
  lastInvoiceDate: string | null;
  lastInvoiceAmount: number | null;
  sampleSize: number;
  status: 'learning' | 'locked' | 'paused';
  lastRecomputedAt: string | null;
}

// ─── Helpers (unexported) ─────────────────────────────────────────────────────

function toDateString(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Median value from a sorted numeric array. Returns null for empty arrays. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Infer cadence from median gap (in days) between consecutive invoice dates.
 *   monthly:   25–40 days
 *   quarterly: 80–100 days
 *   annual:    330–400 days
 *   irregular: anything else or insufficient data
 */
function inferCadence(invoiceDates: string[]): 'monthly' | 'quarterly' | 'annual' | 'irregular' {
  if (invoiceDates.length < 2) return 'irregular';
  const gaps: number[] = [];
  for (let i = 1; i < invoiceDates.length; i++) {
    const prev = new Date(invoiceDates[i - 1]!).getTime();
    const curr = new Date(invoiceDates[i]!).getTime();
    const diffDays = Math.abs(Math.round((prev - curr) / 86_400_000));
    gaps.push(diffDays);
  }
  const med = median([...gaps].sort((a, b) => a - b));
  if (med === null) return 'irregular';
  if (med >= 25 && med <= 40) return 'monthly';
  if (med >= 80 && med <= 100) return 'quarterly';
  if (med >= 330 && med <= 400) return 'annual';
  return 'irregular';
}

/** Modal day-of-month from an array of ISO date strings. */
function modalDayOfMonth(dates: string[]): number | null {
  if (dates.length === 0) return null;
  const freq: Record<number, number> = {};
  for (const d of dates) {
    const day = new Date(d).getUTCDate();
    freq[day] = (freq[day] ?? 0) + 1;
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [day, count] of Object.entries(freq)) {
    if (count > bestCount) {
      bestCount = count;
      best = Number(day);
    }
  }
  return best;
}

/** Trimmed mean: drop top and bottom 10% of values. Falls back to plain mean for small sets. */
function trimmedMean(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * 0.1);
  const trimmed = trim > 0 ? sorted.slice(trim, sorted.length - trim) : sorted;
  if (trimmed.length === 0) return null;
  return trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
}

/** Sample standard deviation. */
function sampleStddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function mapRow(row: Row): SupplierExpectation {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    supplierId: String(row.supplier_id),
    cadence: row.cadence as SupplierExpectation['cadence'],
    expectedDayOfMonth: row.expected_day_of_month != null ? Number(row.expected_day_of_month) : null,
    expectedAmount: row.expected_amount != null ? Number(row.expected_amount) : null,
    amountStddev: row.amount_stddev != null ? Number(row.amount_stddev) : null,
    lastInvoiceDate: toDateString(row.last_invoice_date as Date | string | null),
    lastInvoiceAmount: row.last_invoice_amount != null ? Number(row.last_invoice_amount) : null,
    sampleSize: Number(row.sample_size),
    status: row.status as SupplierExpectation['status'],
    lastRecomputedAt: row.last_recomputed_at
      ? toDateString(row.last_recomputed_at as Date | string)
      : null,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function listExpectations(companyId: string): Promise<SupplierExpectation[]> {
  const rows = await sql`
    SELECT * FROM supplier_expectations
    WHERE company_id = ${companyId}::uuid
    ORDER BY created_at DESC
  ` as Row[];
  return rows.map(mapRow);
}

export async function getExpectation(
  companyId: string,
  supplierId: string,
): Promise<SupplierExpectation | null> {
  const rows = await sql`
    SELECT * FROM supplier_expectations
    WHERE company_id = ${companyId}::uuid
      AND supplier_id = ${supplierId}::uuid
    LIMIT 1
  ` as Row[];
  return rows.length > 0 ? mapRow(rows[0]!) : null;
}

export async function recomputeForSupplier(
  companyId: string,
  supplierId: string,
): Promise<SupplierExpectation> {
  // Fetch last 6 invoices sorted desc
  const invoiceRows = await sql`
    SELECT invoice_date, total_amount
    FROM supplier_invoices
    WHERE company_id = ${companyId}::uuid
      AND supplier_id = ${supplierId}::uuid
      AND deleted_at IS NULL
    ORDER BY invoice_date DESC
    LIMIT 6
  ` as Row[];

  const sampleSize = invoiceRows.length;
  const dates = invoiceRows.map(r => toDateString(r.invoice_date as Date | string)!).filter(Boolean);
  const amounts = invoiceRows.map(r => Number(r.total_amount));

  const cadence = inferCadence(dates);
  const expectedDayOfMonth = (cadence === 'irregular' || cadence === 'annual')
    ? null
    : modalDayOfMonth(dates);
  const expectedAmount = trimmedMean(amounts);
  const amountStddev = sampleStddev(amounts);
  const lastInvoiceDate = dates[0] ?? null;
  const lastInvoiceAmount = amounts.length > 0 ? amounts[0]! : null;

  // Fetch existing status to respect 'paused'
  const existing = await getExpectation(companyId, supplierId);
  let newStatus: SupplierExpectation['status'];
  if (existing?.status === 'paused') {
    newStatus = 'paused';
  } else if (sampleSize >= 3 && cadence !== 'irregular') {
    newStatus = 'locked';
  } else {
    newStatus = 'learning';
  }

  const rows = await sql`
    INSERT INTO supplier_expectations (
      company_id, supplier_id, cadence,
      expected_day_of_month, expected_amount, amount_stddev,
      last_invoice_date, last_invoice_amount,
      sample_size, status, last_recomputed_at
    ) VALUES (
      ${companyId}::uuid, ${supplierId}::uuid, ${cadence},
      ${expectedDayOfMonth}, ${expectedAmount}, ${amountStddev},
      ${lastInvoiceDate}::date, ${lastInvoiceAmount},
      ${sampleSize}, ${newStatus}, NOW()
    )
    ON CONFLICT (company_id, supplier_id) DO UPDATE SET
      cadence             = EXCLUDED.cadence,
      expected_day_of_month = EXCLUDED.expected_day_of_month,
      expected_amount     = EXCLUDED.expected_amount,
      amount_stddev       = EXCLUDED.amount_stddev,
      last_invoice_date   = EXCLUDED.last_invoice_date,
      last_invoice_amount = EXCLUDED.last_invoice_amount,
      sample_size         = EXCLUDED.sample_size,
      status              = CASE
        WHEN supplier_expectations.status = 'paused' THEN 'paused'::text
        ELSE EXCLUDED.status
      END,
      last_recomputed_at  = NOW(),
      updated_at          = NOW()
    RETURNING *
  ` as Row[];

  log.info('Recomputed supplier expectation', {
    companyId, supplierId, cadence, sampleSize, status: newStatus,
  }, 'expectationEngine');

  return mapRow(rows[0]!);
}

export async function recomputeAllForCompany(
  companyId: string,
): Promise<{ processed: number; locked: number }> {
  // Get distinct suppliers with at least 1 invoice
  const supplierRows = await sql`
    SELECT DISTINCT supplier_id
    FROM supplier_invoices
    WHERE company_id = ${companyId}::uuid
      AND deleted_at IS NULL
  ` as Row[];

  let processed = 0;
  let locked = 0;

  for (const row of supplierRows) {
    try {
      const exp = await recomputeForSupplier(companyId, String(row.supplier_id));
      processed++;
      if (exp.status === 'locked') locked++;
    } catch (err) {
      log.warn('recomputeAllForCompany: failed for supplier', {
        supplierId: row.supplier_id, error: err,
      }, 'expectationEngine');
    }
  }

  log.info('recomputeAllForCompany complete', { companyId, processed, locked }, 'expectationEngine');
  return { processed, locked };
}
