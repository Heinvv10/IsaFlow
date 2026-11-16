/**
 * Loan repayments and recurring-invoice receipts for the forecast (ruling 2026-11-16).
 *   - Loans: each ACTIVE loan's schedule (`previewSchedule`, loans/loanScheduleService.ts — it writes
 *     nothing), the rows dated today to the horizon end; the cash out is the instalment plus any lump sum.
 *     Each loan in its own savepoint, so one loan whose schedule cannot be read leaves the others.
 *   - Recurring invoices: the active templates (`getRecurringInvoices`) through recurringItems.ts, each run
 *     collected on the due date the runner would give it (the customer's terms, else the company default).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { previewSchedule } from '@/modules/accounting/services/loans/loanScheduleService';
import { getRecurringInvoices } from '@/modules/accounting/services/ar/recurringInvoiceService';
import { COMPANY_DEFAULT_TERMS_KEY, companyTermsFromSetting, dueDateWithDefault } from '@/modules/accounting/services/shared/paymentTerms';
import { guardedSource } from './guardedSource';
import { toCents } from './lines';
import { recurringItems, type RecurringTemplateRow } from './recurringItems';
import type { ForecastWarning, KnownItem } from './types';

/** More active templates than this are read in pages of this size. */
const TEMPLATE_PAGE = 500;

export async function loanItems(companyId: string, today: string, horizonEnd: string, warnings: ForecastWarning[]): Promise<KnownItem[]> {
  const loans = (await sql`
    SELECT id, COALESCE(NULLIF(description, ''), NULLIF(reference, ''), product, 'Loan') AS label
    FROM loans WHERE company_id = ${companyId}::UUID AND status = 'active'
    ORDER BY id
  `) as DbRow[];
  const items: KnownItem[] = [];
  for (const loan of loans) {
    const id = String(loan.id);
    const rows = await guardedSource('cash13_loan', `loan ${String(loan.label)}`, warnings, () => previewSchedule(companyId, id));
    for (const r of rows ?? []) {
      if (r.date < today || r.date > horizonEnd) continue;
      const cents = toCents(r.payment) + toCents(r.lump);
      if (cents === 0) continue;
      items.push({
        lineKey: `loan:${id}`, lineLabel: `Loan repayment: ${String(loan.label)}`, category: 'loans', date: r.date,
        amountCents: -cents, ref: `${id}:${r.period}`, refLabel: `Instalment ${r.period}`,
      });
    }
  }
  return items;
}

export async function recurringReceiptItems(companyId: string, today: string, horizonEnd: string): Promise<KnownItem[]> {
  const templates: RecurringTemplateRow[] = [];
  for (let offset = 0; ; offset += TEMPLATE_PAGE) {
    const page = await getRecurringInvoices(companyId, { status: 'active', limit: TEMPLATE_PAGE, offset });
    for (const t of page.items) {
      templates.push({
        id: t.id, name: t.templateName, customerId: t.clientId, customerName: t.clientName ?? 'Unknown customer', frequency: t.frequency,
        nextRunDate: t.nextRunDate, endDate: t.endDate ?? null, totalCents: toCents(t.totalAmount),
      });
    }
    if (page.items.length < TEMPLATE_PAGE) break;
  }
  if (templates.length === 0) return [];
  // The runner's terms (recurringInvoiceLock.ts): the customer's, else the company default setting.
  const ids = [...new Set(templates.map((t) => t.customerId))];
  const terms = (await sql`
    SELECT c.id, c.payment_terms, c.payment_terms_type
    FROM customers c WHERE c.company_id = ${companyId}::UUID AND c.id = ANY(${ids}::UUID[])
  `) as DbRow[];
  const byCustomer = new Map(terms.map((r) => [String(r.id), r]));
  const settingRows = (await sql`
    SELECT value FROM accounting_settings WHERE company_id = ${companyId}::UUID AND key = ${COMPANY_DEFAULT_TERMS_KEY}
  `) as DbRow[];
  const companyDefault = companyTermsFromSetting(settingRows[0]?.value, companyId);
  return recurringItems(templates, today, horizonEnd, (t, invoiceDate) => {
    const c = byCustomer.get(t.customerId);
    const days = c?.payment_terms == null ? null : Number(c.payment_terms);
    return dueDateWithDefault(invoiceDate, days, c?.payment_terms_type == null ? null : String(c.payment_terms_type), companyDefault) ?? invoiceDate;
  });
}
