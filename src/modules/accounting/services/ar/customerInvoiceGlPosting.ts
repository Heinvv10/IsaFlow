/**
 * Customer invoice GL posting: DR AR / CR Revenue / CR VAT Output.
 * Extracted from customerPaymentAllocationService.ts (2026-10-05) so the
 * VAT-guard allowlist entry for this poster's `vatType: 'standard'` covers it
 * alone, not the payment-allocation code beside it.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { resolveUserUuid } from '../gl/journalEntryCrudService';
import { defaultHumanMeta, actorMeta, type PostingActorOpts } from '../gl/journalEntryMeta';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { assertNoInactiveAccountLines } from '../gl/journalEntryPostingService';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { assertJournalVatPeriodOpen } from '../gl/journalVatLockGuard';
import type { JournalLineInput } from '../../types/gl.types';
import { documentInPopulation } from '../shared/documentPopulation';
import { invoiceRevenueJournalLines } from './invoiceRevenuePosting';
import { assertDocumentPostable } from '../shared/documentCurrency';
import { POST_AS_STORED } from '../gl/dimensions/dimensionStoredPosting';

type Row = DbRow;

/**
 * @param opts.postingAgent Stamp for the AR journal this posts. Optional and
 *   last-positional so every existing caller keeps its current
 *   `human:<userId>` attribution; only callers that are NOT a human clicking
 *   Approve (the MCP finalize_invoice tool) pass it. Mirrors the
 *   reverseJournalEntry / reverseReconciledTransaction opts pattern.
 */
export async function postCustomerInvoiceToGL(
  companyId: string,
  invoiceId: string,
  userId: string,
  // approvingFromStatus: the status approveCustomerInvoice moved the invoice FROM (it is 'approved' by now).
  opts?: PostingActorOpts & { historicalImport?: boolean; approvingFromStatus?: string },
): Promise<string> {
  try {
    const invRows = (await sql`
      SELECT ci.*, c.name AS client_name
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
      WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
    `) as Row[];
    if (invRows.length === 0) throw new Error(`Invoice ${invoiceId} not found`);
    const inv = invRows[0]!;

    // Cancel NULLs gl_journal_entry_id after reversing the journal — without
    // this status guard the backfill would re-post a fresh AR/Revenue/VAT
    // journal for a cancelled document (the inverse of audit C1).
    if (String(inv.status) === 'cancelled') {
      throw new Error('Cannot post a cancelled invoice to GL');
    }

    if (inv.gl_journal_entry_id) return String(inv.gl_journal_entry_id);

    // R-118, AR side. Below the early return for the same reason as the AP
    // twin: an invoice that already carries a journal posts nothing here.
    // What is refused is a NEW journal for a document outside the AR
    // population — pages/api/accounting/customer-invoices-gl.ts posts whatever
    // invoiceId the body names, with no status filter, so a draft's journal
    // would stand in the GL while documentInPopulationExpr keeps the draft off
    // the document half of every AR-vs-GL reconciliation. Approving is what
    // posts a draft: approveCustomerInvoice sets the status first, then calls
    // this, so the ordinary path is unaffected.
    if (!documentInPopulation(String(inv.status))) {
      throw new Error(
        `Cannot post a ${String(inv.status)} invoice to GL — approve it instead, `
        + 'which posts the journal and moves the status together.',
      );
    }

    // FX PR0: until functional posting lands, a foreign invoice would post its
    // document figures as rands. Refused before any write; the DB gate agrees.
    await assertDocumentPostable(companyId, [inv.currency_code], 'invoice');

    const arAccount = await getSystemAccount('receivable', companyId);
    const revenueAccount = await getSystemAccount('default_revenue', companyId);
    const vatAccount = await getSystemAccount('vat_output', companyId);

    const lines: JournalLineInput[] = [
      { glAccountId: arAccount.id, debit: Number(inv.total_amount), credit: 0,
        description: `AR: ${inv.invoice_number}` },
      // What posts is what is stored (and approved): approving refuses a line saved before its customer's
      // FNO, or its project's, existed; one already approved posts as stored (dimensionStoredPosting).
      ...(await invoiceRevenueJournalLines(companyId, invoiceId, {
        number: String(inv.invoice_number), documentSubtotal: Number(inv.subtotal), credit: Number(inv.subtotal),
      }, revenueAccount.id, opts?.approvingFromStatus ?? String(inv.status))),
    ];

    if (Number(inv.tax_amount) > 0) {
      // Coded 'standard' (2026-10-05), as credit notes since 2026-09-25: an
      // uncoded VAT leg is a blocking pre-filing exception, and 'standard' is
      // what the VAT201 already read it as. Migration 856 backfills the
      // invoice journals posted before this.
      lines.push({
        glAccountId: vatAccount.id, debit: 0, credit: Number(inv.tax_amount),
        description: `VAT Output: ${inv.invoice_number}`, vatType: 'standard',
      });
    }

    // pg returns DATE columns as JS Date objects at LOCAL midnight — on this
    // UTC+2 server toISOString() rolls the date back a day, so every
    // auto_invoice journal was dated one day before its invoice (baseline
    // finding N4). fmtDate uses local getters and handles both shapes.
    const entryDate = fmtDate(inv.invoice_date);

    // Closed-period check runs HERE, before createJournalEntry, not inside
    // postJournalEntry afterwards. pages/api/accounting/customer-invoices-gl.ts
    // catches every error from this function and answers 400, and withAuth only
    // ROLLBACKs on >= 500 -- so a refusal raised after the entry was created
    // would COMMIT an orphan draft journal while reporting failure. Refusing
    // before any write keeps that 400 honest.
    //
    // historicalImport waives it for the Sage migration alone, which exists to
    // land 2022-2024 invoices in their real periods (955 such journals already
    // sit in closed periods in production). Nothing else may pass it.
    if (!opts?.historicalImport) {
      const periodStatus = await getPeriodStatusForDate(companyId, entryDate);
      if (periodStatus === 'closed') {
        throw new Error(
          `Cannot post invoice ${inv.invoice_number} to GL — its fiscal period is closed. ` +
            `Reopen the period, or date the invoice in an open one.`,
        );
      }
    }
    // A locked (filed) VAT period refuses a journal that moves a VAT figure —
    // historicalImport included: a migration may land in a CLOSED fiscal period
    // but not in a filed VAT return. Before createJournalEntry, for the same
    // orphan-draft reason as the period check above.
    await assertJournalVatPeriodOpen(companyId, entryDate, lines);
    // sourceDocumentId FKs to captured_documents(id) — not customer_invoices.
    // The invoice↔JE link is maintained via customer_invoices.gl_journal_entry_id
    // below.
    const je = await createJournalEntry(companyId, {
      entryDate,
      description: `Customer invoice ${inv.invoice_number}`,
      source: 'auto_invoice',
      lines,
    }, userId, actorMeta(opts) ?? defaultHumanMeta(userId), POST_AS_STORED);

    if (opts?.historicalImport) {
      // Historical import diverges from the canonical path (postJournalEntry)
      // for ONE reason: a migrated invoice belongs in its original period, and
      // postJournalEntry refuses a closed one. Every other guard still applies,
      // so the inactive-account check is made explicitly here.
      await assertNoInactiveAccountLines(companyId, je.id);
      const safeUserId = await resolveUserUuid(userId);
      await sql`
        UPDATE gl_journal_entries
        SET status = 'posted', posted_by = ${safeUserId}::UUID, posted_at = NOW()
        WHERE id = ${je.id}::UUID AND company_id = ${companyId}
      `;
    } else {
      // Canonical path: inherits the balance, period and inactive-account
      // guards rather than restating them here.
      await postJournalEntry(companyId, je.id, userId);
    }

    // Use the ALS-bound connection (plain `sql`) rather than withTransaction.
    // withTransaction gets a fresh pool connection that can't see the invoice
    // INSERT when we're nested inside an outer request transaction (e.g. the
    // admin Sage commit handler), so the link-back UPDATE silently matched
    // 0 rows. Same-connection queries participate in the outer tx and see
    // the invoice row.
    await sql`
      UPDATE customer_invoices SET gl_journal_entry_id = ${je.id}::UUID
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    `;

    log.info('Posted customer invoice to GL', { invoiceId, journalEntryId: je.id }, 'accounting');
    return je.id;
  } catch (err) {
    log.error('Failed to post customer invoice to GL', { invoiceId, error: err }, 'accounting');
    throw err;
  }
}
