/**
 * Recurring-invoice receipts for the forecast (ruling 2026-11-16, D1): the active templates
 * (`getRecurringInvoices`) through recurringItems.ts, each run collected on the due date the runner would give
 * it (the customer's terms, else the company default).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getRecurringInvoices } from '@/modules/accounting/services/ar/recurringInvoiceService';
import { COMPANY_DEFAULT_TERMS_KEY, companyTermsFromSetting, dueDateWithDefault } from '@/modules/accounting/services/shared/paymentTerms';
import { toCents } from './lines';
import { recurringItems, type RecurringTemplateRow } from './recurringItems';
import type { KnownItem } from './types';

/** More active templates than this are read in pages of this size. */
const TEMPLATE_PAGE = 500;

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
