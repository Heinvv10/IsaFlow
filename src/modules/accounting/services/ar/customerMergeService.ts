/**
 * Customer merge (K-061): move everything that belongs to `sourceId` onto
 * `targetId`, then soft-delete the source. One transaction; every refusal is
 * raised before the first write, because withAuth COMMITs on a 4xx.
 *
 * The tables moved are the census in docs/audits/remediation/K-061/fix.md. A new table that stores a customer id
 * must be added here AND to `MOVED` in tests/integration/k061-customer-merge.helpers.ts, or a merge strands its
 * rows on the merged-away customer.
 *
 * Product rules (Hein, 2026-09-26):
 *   - both customers with a dunning override → refused, nothing written;
 *   - the source's portal logins are deactivated, never moved;
 *   - the source's active recurring invoices AND recurring transaction
 *     templates (customer id inside template_data) move PAUSED, and are counted;
 *   - the source keeps its name + ' [MERGED]' and its Sage history. A Sage
 *     re-sync matches customers by name and so re-creates the old name as a
 *     new, empty customer; the moved Sage invoices are not booked twice.
 */
import { withTransaction, type TxSql } from '@/lib/neon';
import { ArRequestError } from './arErrors';
import { isLockContention } from '../core/lockContention';
import { moveRulesToCustomer } from '../bank/bankRuleChangeControl';

/**
 * The two unique keys a concurrent writer can collide with mid-merge: the
 * customers are locked FOR NO KEY UPDATE, so a request may still INSERT a
 * dunning override or a custom field for the TARGET after the merge checked
 * for one. Same event as a lock timeout — someone else is writing this
 * customer — and the same answer.
 */
const CONTENDED_UNIQUE_KEYS = new Set([
  'customer_dunning_overrides_pkey',
  'entity_udf_values_company_id_entity_type_entity_id_field_nu_key',
]);

function isMergeContention(err: unknown): boolean {
  if (isLockContention(err)) return true;
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === '23505' && typeof e.constraint === 'string' && CONTENDED_UNIQUE_KEYS.has(e.constraint);
}

export interface CustomerMergeResult {
  merged: true;
  target_id: string;
  /** Invoices, receipts, credit notes, quotes and sales orders re-parented. */
  movedDocuments: number;
  pausedRecurring: number;
  revokedPortalLogins: number;
}

async function refuseOrLock(tx: TxSql, companyId: string, sourceId: string, targetId: string): Promise<void> {
  // Locked in id order so two merges of the same pair, in either direction,
  // queue instead of deadlocking. A merge that waited re-reads deleted_at
  // after the first commits, finds its customer gone, and is refused.
  // NO KEY UPDATE, not UPDATE: a receipt INSERT naming the customer takes FK
  // FOR KEY SHARE on its row, which FOR UPDATE would block for the whole
  // merge. The merge changes no key column of customers, so it needs no more,
  // and NO KEY UPDATE still conflicts with itself. Taken AFTER the settlement
  // rows — see mergeCustomers.
  const live = await tx`
    SELECT id FROM customers
    WHERE id IN (${sourceId}::UUID, ${targetId}::UUID)
      AND company_id = ${companyId}::UUID
      AND deleted_at IS NULL
    ORDER BY id
    FOR NO KEY UPDATE
  `;
  if (live.length !== 2) {
    throw new ArRequestError('One or both customers not found or do not belong to this company');
  }
  const dunning = await tx`
    SELECT count(*)::int AS n FROM customer_dunning_overrides
    WHERE company_id = ${companyId}::UUID AND customer_id IN (${sourceId}::UUID, ${targetId}::UUID)
  ` as Array<{ n: number }>;
  if (dunning[0]!.n === 2) {
    throw new ArRequestError('Both customers have dunning settings — remove one first, then merge');
  }
}

/**
 * The canonical lock order (bank/.claude.md): bank lines, then receipts, then
 * invoices ORDER BY id. A merge re-parents every one of a customer's documents,
 * so it contends with any settlement running for that customer; taking them
 * in any other order deadlocks against it (40P01 → 500).
 */
async function lockSettlementRows(tx: TxSql, c: string, s: string): Promise<{ payments: number; invoices: number }> {
  await tx`
    SELECT id FROM bank_transactions
    WHERE suggested_client_id = ${s}::UUID AND company_id = ${c}::UUID ORDER BY id FOR UPDATE
  `;
  const payments = await tx`
    SELECT id FROM customer_payments
    WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID ORDER BY id FOR UPDATE
  `;
  const invoices = await tx`
    SELECT id FROM customer_invoices
    WHERE (customer_id = ${s}::UUID OR client_id = ${s}::UUID) AND company_id = ${c}::UUID ORDER BY id FOR UPDATE
  `;
  // Both recurring runners lock their template and then INSERT an invoice
  // naming the customer. Taking the templates here, before any UPDATE runs,
  // means a run already in progress commits first and the invoice UPDATE in
  // moveDocuments then sees — and moves — the invoice it created. Taken after
  // the moves, the merge waited for that run and then stranded its invoice.
  await tx`
    SELECT id FROM recurring_invoices
    WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID ORDER BY id FOR UPDATE
  `;
  await tx`
    SELECT id FROM recurring_transaction_templates
    WHERE company_id = ${c}::UUID AND entity_type = 'customer_invoice'
      AND lower(template_data->>'clientId') = ${s}
    ORDER BY id FOR UPDATE
  `;
  return { payments: payments.length, invoices: invoices.length };
}

/** Documents: every customer column moves independently; a NULL stays NULL. Returns the other documents moved.
 * A credit note's client (R-035 PR3), an invoice's customer_id/client_id and a quote's or order's customer (PR4) are
 * approval content: the merging user `by` becomes an author of each it moves; an old approval goes stale (Q10). */
async function moveDocuments(tx: TxSql, c: string, s: string, t: string, by: string): Promise<number> {
  await tx`UPDATE bank_transactions SET suggested_client_id = ${t}::UUID WHERE suggested_client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE customer_payments SET client_id = ${t}::UUID WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`
    UPDATE customer_invoices SET customer_id = ${t}::UUID,
      content_authors = approval_add_author(content_authors, ${by}::UUID), content_edited_at = NOW()
    WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID
  `;
  await tx`
    UPDATE customer_invoices SET client_id = ${t}::UUID,
      content_authors = approval_add_author(content_authors, ${by}::UUID), content_edited_at = NOW()
    WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID
  `;
  const notes = await tx`
    UPDATE credit_notes SET client_id = ${t}::UUID,
      content_authors = approval_add_author(content_authors, ${by}::UUID), content_edited_at = NOW()
    WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID RETURNING id
  `;
  await tx`UPDATE customer_write_offs SET client_id = ${t}::UUID WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  const quotes = await tx`UPDATE customer_quotes SET client_id = ${t}::UUID, content_authors = approval_add_author(content_authors, ${by}::UUID)
    WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID RETURNING id`;
  const orders = await tx`UPDATE customer_sales_orders SET customer_id = ${t}::UUID, content_authors = approval_add_author(content_authors, ${by}::UUID)
    WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID RETURNING id`;
  await tx`UPDATE delivery_notes SET customer_id = ${t}::UUID WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE projects SET client_id = ${t}::UUID WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE time_entries SET customer_id = ${t}::UUID WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE payment_transactions SET customer_id = ${t}::UUID WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`
    UPDATE accounting_adjustments SET entity_id = ${t}::UUID
    WHERE entity_type = 'customer' AND entity_id = ${s}::UUID AND company_id = ${c}::UUID
  `;
  // Payment links have no company_id; the invoice they belong to does.
  await tx`
    UPDATE portal_payment_links SET client_id = ${t}::UUID
    WHERE client_id = ${s}::UUID
      AND invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ${c}::UUID)
  `;
  return notes.length + quotes.length + orders.length;
}

/** Customer records: the target's primary contact, default address and custom fields win. */
async function moveRecords(tx: TxSql, c: string, s: string, t: string): Promise<void> {
  await tx`
    UPDATE customer_contacts
    SET customer_id = ${t}::UUID,
        is_primary = is_primary AND NOT EXISTS (
          SELECT 1 FROM customer_contacts p
          WHERE p.customer_id = ${t}::UUID AND p.company_id = ${c}::UUID AND p.is_primary)
    WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID
  `;
  await tx`
    UPDATE customer_delivery_addresses
    SET customer_id = ${t}::UUID,
        is_default = is_default AND NOT EXISTS (
          SELECT 1 FROM customer_delivery_addresses d
          WHERE d.customer_id = ${t}::UUID AND d.company_id = ${c}::UUID AND d.is_default)
    WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID
  `;
  await tx`UPDATE customer_activities SET customer_id = ${t}::UUID WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  // refuseOrLock already refused the case where both have one. An override
  // created for the target after that check (the customer lock no longer
  // blocks the FK) makes this UPDATE raise 23505, answered 409 by
  // isMergeContention; the savepoint rolls the whole merge back.
  await tx`UPDATE customer_dunning_overrides SET customer_id = ${t}::UUID WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE practice_clients SET link_customer_id = ${t}::UUID WHERE link_customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`
    DELETE FROM entity_udf_values v
    WHERE v.entity_type = 'customer' AND v.entity_id = ${s}::UUID AND v.company_id = ${c}::UUID
      AND EXISTS (
        SELECT 1 FROM entity_udf_values w
        WHERE w.entity_type = 'customer' AND w.entity_id = ${t}::UUID
          AND w.company_id = ${c}::UUID AND w.field_number = v.field_number)
  `;
  await tx`
    UPDATE entity_udf_values SET entity_id = ${t}::UUID
    WHERE entity_type = 'customer' AND entity_id = ${s}::UUID AND company_id = ${c}::UUID
  `;
}

/**
 * Both recurring stores move to the target PAUSED (Hein): `recurring_invoices` by column, and
 * `recurring_transaction_templates` whose customer_invoice template names the customer inside its JSON
 * (`template_data.clientId`, read by recurringTransactionInvoices). Returns how many running ones were paused.
 * The client is what a template bills: the merging user `by` becomes an author of each (R-035 PR4 review F1).
 */
async function moveRecurring(tx: TxSql, c: string, s: string, t: string, by: string): Promise<number> {
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

export async function mergeCustomers(
  companyId: string,
  sourceIdIn: string,
  targetIdIn: string,
  /** The user merging — stamped as an author of the credit notes and invoices moved. */
  mergedBy: string,
): Promise<CustomerMergeResult> {
  // Callers validate with a case-insensitive UUID pattern; one spelling here
  // makes "same customer" a string comparison and the JSON match exact.
  const sourceId = sourceIdIn.toLowerCase();
  const targetId = targetIdIn.toLowerCase();
  if (sourceId === targetId) {
    throw new ArRequestError('source_id and target_id must be different customers');
  }
  try {
    return await withTransaction((tx) => mergeInSavepoint(tx, companyId, sourceId, targetId, mergedBy));
  } catch (err) {
    // FAIL CLOSED on contention. A merge touches every row of a customer, so
    // a multi-step settlement (a bulk allocation that takes bank line →
    // invoices → bank line) can still interleave with it however the merge
    // orders its own locks. The wait is bounded, and a 55P03/40P01 — or a
    // unique-key collision with a concurrent insert for the target — is
    // answered as "retry": the savepoint rolled back, so nothing was merged.
    if (isMergeContention(err)) {
      throw new ArRequestError(
        'Another request is updating this customer (a payment, allocation or recurring run). Nothing was merged — retry in a moment.',
        409,
        'CUSTOMER_MERGE_CONTENDED',
      );
    }
    throw err;
  }
}

async function mergeInSavepoint(
  tx: TxSql, companyId: string, sourceId: string, targetId: string, mergedBy: string,
): Promise<CustomerMergeResult> {
  // Bounded wait; restored below on success, and by the savepoint's ROLLBACK TO on failure (SET LOCAL is subtransaction-aware).
  await tx`SET LOCAL lock_timeout = '5s'`;
  // Settlement rows BEFORE the customers: a bank allocation or refund takes
  // the bank line and then the customer (lockContactForRefund FOR UPDATE, or
  // the FK KEY SHARE of its receipt INSERT). Customers first would be the
  // inverse order — a 40P01 cycle. Locks are not writes: every refusal
  // below still precedes the first write.
  const locked = await lockSettlementRows(tx, companyId, sourceId);
  await refuseOrLock(tx, companyId, sourceId, targetId);
  await moveRulesToCustomer(tx, companyId, sourceId, targetId); // may refuse (bank_rule): before any other write
  const others = await moveDocuments(tx, companyId, sourceId, targetId, mergedBy);
  await moveRecords(tx, companyId, sourceId, targetId);
  const pausedRecurring = await moveRecurring(tx, companyId, sourceId, targetId, mergedBy);
  // No RLS here: scoped through the customer refuseOrLock proved is ours. Removed, not
  // deactivated: no app role may UPDATE portal_access (S-07d, 937), which could revive it.
  const revoked = await tx`
    DELETE FROM portal_access
    WHERE client_id = ${sourceId}::UUID AND is_active
      AND EXISTS (SELECT 1 FROM customers WHERE id = ${sourceId}::UUID AND company_id = ${companyId}::UUID)
    RETURNING id
  `;
  await tx`
    UPDATE customers
    SET is_active = false, deleted_at = NOW(), name = name || ' [MERGED]'
    WHERE id = ${sourceId}::UUID AND company_id = ${companyId}::UUID
  `;
  await tx`SET LOCAL lock_timeout = DEFAULT`;
  return {
    merged: true,
    target_id: targetId,
    movedDocuments: locked.payments + locked.invoices + others,
    pausedRecurring,
    revokedPortalLogins: revoked.length,
  };
}
