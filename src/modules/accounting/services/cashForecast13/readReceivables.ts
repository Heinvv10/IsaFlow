/**
 * Open AR and AP for the forecast, from the aging's own fetchers (one definition of "open"), plus each
 * customer's payment history, foreign documents converted (review L6) and unapplied credit netted (M2).
 *
 * PAID DATE (census): an invoice's paid date is the latest `payment_date` of the customer receipts allocated
 * to it (customer_payment_allocations → customer_payments, status not draft/cancelled) — the datable
 * settlement the aging rewind uses (shared/agingRewind.ts). `paid_at` is not used: it is stamped NOW() when the
 * settlement is captured, not when the customer paid. An invoice settled with no receipt allocation (credit
 * note only, or a legacy amount_paid with no trail) has no paid date and does not count toward history.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fetchARAgingInvoices } from '@/modules/accounting/services/ar/arAgingInvoices';
import { fetchAPAgingInvoices } from '@/modules/accounting/services/ap/apAgingInvoices';
import { getUnappliedByEntity } from '@/modules/accounting/services/shared/agedNetting';
import { arItems, overdueSummary } from './arExpected';
import { netCredits, warnUnusedCredit } from './creditNetting';
import { convertDocs, excludedMessage, type DocCurrency } from './fx';
import { toCents } from './lines';
import type { ForecastWarning, KnownItem, OverdueArSummary } from './types';

/** Per customer, the days late (paid date − due date) of each fully paid invoice with a paid date in the 12 months to today. */
export async function readCustomerDaysLate(companyId: string, today: string): Promise<Map<string, number[]>> {
  const rows = (await sql`
    SELECT COALESCE(ci.client_id, ci.customer_id) AS customer_id,
           (paid.paid_date - COALESCE(ci.due_date, ci.invoice_date, ci.created_at::date)) AS days_late
    FROM customer_invoices ci
    JOIN LATERAL (
      SELECT MAX(cp.payment_date) AS paid_date
      FROM customer_payment_allocations cpa
      JOIN customer_payments cp ON cp.id = cpa.payment_id AND cp.company_id = ${companyId}::UUID
      WHERE cpa.invoice_id = ci.id
        AND cp.status NOT IN ('draft', 'cancelled')
    ) paid ON paid.paid_date IS NOT NULL
    WHERE ci.company_id = ${companyId}::UUID
      AND ci.status = 'paid'
      AND ci.deleted_at IS NULL
      AND paid.paid_date > (${today}::date - INTERVAL '12 months')::date
      AND paid.paid_date <= ${today}::date
    ORDER BY 1, 2
  `) as DbRow[];
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const id = String(r.customer_id);
    const list = out.get(id) ?? [];
    list.push(Number(r.days_late));
    out.set(id, list);
  }
  return out;
}

/** Each open document's currency and stored rate, with the company's functional currency (one query per side). */
async function currencies(companyId: string, side: 'ar' | 'ap', ids: string[]): Promise<{ fx: Map<string, DocCurrency>; functional: string }> {
  const rows = (side === 'ar'
    ? await sql`
        SELECT d.id, NULLIF(upper(btrim(d.currency_code)), '') AS code_a, NULL::TEXT AS code_b, d.exchange_rate
        FROM customer_invoices d
        WHERE d.company_id = ${companyId}::UUID AND d.id = ANY(${ids}::UUID[])`
    : await sql`
        SELECT d.id, NULLIF(upper(btrim(d.currency_code)), '') AS code_a, NULLIF(upper(btrim(d.currency)), '') AS code_b, d.exchange_rate
        FROM supplier_invoices d
        WHERE d.company_id = ${companyId}::UUID AND d.id = ANY(${ids}::UUID[])`) as DbRow[];
  const fn = (await sql`SELECT functional_currency FROM companies WHERE id = ${companyId}::UUID`) as DbRow[];
  const functional = String(fn[0]?.functional_currency ?? 'ZAR');
  // Foreign when EITHER column names another currency (fx_row_is_foreign, migration 871).
  const foreignCode = (r: DbRow) => [r.code_a, r.code_b].find((c) => c != null && c !== functional) ?? null;
  return {
    fx: new Map(rows.map((r) => [String(r.id), { currency: foreignCode(r) as string | null, rate: r.exchange_rate == null ? null : Number(r.exchange_rate) }])),
    functional,
  };
}

/** Per entity, the unapplied receipts / payments on account and credit notes (shared/agedNetting), in cents. */
async function creditByEntity(companyId: string, side: 'ar' | 'ap', today: string): Promise<Map<string, number>> {
  const byEntity = await getUnappliedByEntity(companyId, side, today);
  return new Map([...byEntity].map(([id, u]) => [id, toCents(u.total)]));
}

export interface OpenItemsRead {
  /** Netted: what the forecast expects. */
  items: KnownItem[];
  /** Before netting: what the budget fill subtracts (re-review N1). */
  gross: KnownItem[];
}

/**
 * Open AR, dated by arExpected, foreign documents converted (fx.ts), each customer's unapplied credit netted
 * earliest first by expected date (creditNetting.ts); the overdue summary is taken over what is then forecast.
 * Credit left over is returned per customer for the recurring receipts (re-review L-c), not warned here.
 */
export async function readReceivables(
  companyId: string, today: string, horizonEnd: string, warnings: ForecastWarning[],
): Promise<OpenItemsRead & { summary: OverdueArSummary; leftover: Map<string, number> }> {
  const open = await fetchARAgingInvoices(companyId, today, today);
  const { fx, functional } = await currencies(companyId, 'ar', open.map((i) => i.id));
  const converted = convertDocs(open.map((i) => ({
    id: i.id, invoiceNumber: i.invoiceNumber, customerId: i.entityId, customerName: i.entityName, dueDate: i.dueDate,
    balanceCents: toCents(i.balance), disputedCents: toCents(i.disputedAmount ?? 0),
  })), fx, functional);
  if (converted.excluded.size > 0) warnings.push({ code: 'currency_not_converted', source: 'customer invoices', message: excludedMessage('Customer invoices', converted.excluded) });
  const dated = arItems(converted.docs, await readCustomerDaysLate(companyId, today), today);
  const netted = netCredits(dated.items, await creditByEntity(companyId, 'ar', today));
  return {
    items: netted.items, gross: dated.items, summary: overdueSummary(netted.items, dated.disputedCents, horizonEnd),
    leftover: new Map(netted.unused.map((u) => [u.entityId, u.cents])),
  };
}

/** Open supplier bills by due date (a missing one is the bill date, as the aging dates it), converted and netted as AR is; overdue lands in week 1. */
export async function readPayables(companyId: string, today: string, warnings: ForecastWarning[]): Promise<OpenItemsRead> {
  const open = await fetchAPAgingInvoices(companyId, today, today);
  const { fx, functional } = await currencies(companyId, 'ap', open.map((b) => b.id));
  const converted = convertDocs(open.map((b) => ({ ...b, balanceCents: toCents(b.balance), disputedCents: 0 })), fx, functional);
  if (converted.excluded.size > 0) warnings.push({ code: 'currency_not_converted', source: 'supplier invoices', message: excludedMessage('Supplier invoices', converted.excluded) });
  const gross: KnownItem[] = converted.docs.map((b) => ({
    lineKey: `ap:${b.entityId}`, lineLabel: b.entityName, category: 'supplier_payments' as const, entityId: b.entityId,
    date: b.dueDate, amountCents: -b.balanceCents, ref: b.id, refLabel: b.invoiceNumber,
  }));
  const netted = netCredits(gross, await creditByEntity(companyId, 'ap', today));
  warnUnusedCredit(netted.unused, 'supplier credit', warnings);
  return { items: netted.items, gross };
}
