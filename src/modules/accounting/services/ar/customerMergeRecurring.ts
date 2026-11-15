/**
 * The recurring half of a customer merge (K-061), split out of `customerMergeService` to keep it under the file cap.
 * Callers hold the customer locks and the recurring rows' locks (`lockSettlementRows`).
 */
import type { TxSql } from '@/lib/neon';

/**
 * Both recurring stores move to the target PAUSED (Hein): `recurring_invoices` by column, and
 * `recurring_transaction_templates` whose customer_invoice template names the customer inside its JSON
 * (`template_data.clientId`, read by recurringTransactionInvoices). Returns how many running ones were paused.
 * The client is what a template bills: the merging user `by` becomes an author of each (R-035 PR4 review F1).
 */
export async function moveRecurring(tx: TxSql, c: string, s: string, t: string, by: string): Promise<number> {
  const paused = await tx`
    UPDATE recurring_invoices SET status = 'paused'
    WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID AND status = 'active'
    RETURNING id
  `;
  await tx`UPDATE recurring_invoices SET client_id = ${t}::UUID, content_authors = approval_add_author(content_authors, ${by}::UUID)
    WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  const pausedTemplates = await tx`
    UPDATE recurring_transaction_templates SET is_active = false
    WHERE company_id = ${c}::UUID AND entity_type = 'customer_invoice'
      AND lower(template_data->>'clientId') = ${s} AND is_active = true
    RETURNING id
  `;
  await tx`
    UPDATE recurring_transaction_templates
    SET template_data = jsonb_set(template_data, '{clientId}', to_jsonb(${t}::TEXT)),
      content_authors = approval_add_author(content_authors, ${by}::UUID)
    WHERE company_id = ${c}::UUID AND entity_type = 'customer_invoice'
      AND lower(template_data->>'clientId') = ${s}
  `;
  return paused.length + pausedTemplates.length;
}
