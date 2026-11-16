/**
 * PRD-060: FibreFlow Accounting Module — Phase 4
 * Bank Allocation Service — Sage Process Bank equivalent (allocate, split, reverse)
 *
 * allocateTransaction lives here; its plan (bankAllocationPlan), journal-line arms (bankAllocationArms)
 * and contact documents (bankAllocationDocuments) are its own steps, in the order they always ran.
 * Split (bankSplitAllocate) and reverse (bankReverseReconciled) are re-exported for every import site.
 */

import { refuseLineOfCompletedReconciliation } from './reconciledCash';
import { sql, withTransaction } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import type { LateClaimInfo } from '../gl/vatLateClaimPlan';
import type { JournalEntryMeta, PostingActorOpts } from '../gl/journalEntryMeta';
import { mapTxRow } from './bankTransactionQueryService';
import type { BankTransaction } from '../../types/bank.types';
import { insertCustomerBankReceipt } from '../ar/customerBankReceipt';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import { assertReallocatableRow } from './bankReallocationGuards';
import { assertPostedForAllocation } from './bankFeedStateGuard';
import { autoLinkCounterpartyTransfer } from './bankTransferAutoLink';
import { assertCustomerInCompany, assertSupplierInCompany } from '../core/contactDirectoryService';
import { DEFAULT_AUTO_APPLY, type AutoApplyMode } from '../shared/autoAllocateStrategy';
import { assertBankLineMayPaySupplier, isBankEvidenced } from '../ap/bankLinePaymentGate';
import { assertBankLineMayPostToAccounts } from './bankLineJournalGate';
import { assertImporterMayAllocateAs } from './bankLineImporterGate';
import { stampContraDimensions } from './bankAllocationDimensions';
import { recordAllocationDecision } from './codingDecisionLog';
import { planAllocationPosting } from './bankAllocationPlan';
import { buildAllocationArm } from './bankAllocationArms';
import { invoiceSourceDocumentOf, recordAllocationDocuments } from './bankAllocationDocuments';
import { assertAllocationVatCode } from './bankVatCodes';

export { splitAllocateTransaction } from './bankSplitAllocate';
export { reverseReconciledTransaction } from './bankReverseReconciled';

type Row = DbRow;


// The allocation shapes live in bankAllocationTypes.ts; re-exported for every existing import site.
export type { AllocationType, AllocationApplicationResult, SplitLine } from './bankAllocationTypes';
import type { AllocationType, AllocationApplicationResult } from './bankAllocationTypes';
import { isBankContraPlan, refuseOwnBankContra } from './bankContraTransfer';

// ── Allocate ──────────────────────────────────────────────────────────────────

/**
 * Allocate a bank transaction — Sage Process Bank equivalent.
 * Supports: account (GL), supplier (AP payment), customer (AR receipt).
 */
export async function allocateTransaction(
  companyId: string, bankTxId: string, contraAccountId: string | null, userId: string,
  description?: string, requestedAllocType: AllocationType = 'account', entityId?: string,
  vatCode?: string, cc1Id?: string, cc2Id?: string, buId?: string,
  invoiceId?: string,
  /**
   * `autoApply: 'none'` says the CALLER has already named what this cash is for
   * — a purchase order, say — so the payment document is still created but
   * nothing is applied to the contact's open documents. Applying it elsewhere
   * would contradict the instruction the caller just gave.
   *
   * Default `'fifo'`: a line with no named target settles that contact's
   * oldest open documents. It used to default to the contact's own
   * `auto_allocate_strategy`, which is 'off' on every row nobody edited — so
   * the cash got a document and closed nothing.
   */
  // allowLateInputClaim: a USER's allocation only (gl/vatLateClaimPlan) — never the rule auto-post.
  // unattended: the auto-post gate's own post (autoPostGateService), which records its own decision.
  // reallocation: bankReallocationService alone — the line's own completed reconciliation, re-checked on the locked row.
  opts?: PostingActorOpts & {
    autoApply?: AutoApplyMode; allowLateInputClaim?: boolean; unattended?: boolean;
    reallocation?: { reconciliationId: string };
  },
): Promise<{
  journalEntryId: string;
  bankTransaction: BankTransaction;
  /** Set when the allocation's input VAT was claimed late (s16(3)). */
  lateClaim?: LateClaimInfo;
  /** Present only for a supplier/customer line that named no document. */
  application?: AllocationApplicationResult;
}> {
  // WP2 row 13: a code outside none / standard / zero_rated / exempt posted the gross with no VAT, silently, on every
  // arm. Refused from the request itself, before the lock and every write (bankVatCodes).
  assertAllocationVatCode(vatCode, 'This allocation');
  // FOR UPDATE: hold the row for the rest of the request so a concurrent
  // allocate blocks here rather than passing the same status check and posting
  // a second journal for one transaction.
  const tx = await lockBankTransactionForUpdate(companyId, bankTxId);
  // BankAllocationRefusal, not a bare Error: both are decided from the locked
  // row before the first write, and a caller that can show that ordering may
  // answer them with a 4xx instead of the 500 every later throw here needs.
  if (!tx) throw new BankAllocationRefusal(`Bank transaction ${bankTxId} not found`);
  // A pending/removed feed row carries status 'imported', so the status check
  // below would let it through. Refused from the locked row, before any write.
  assertPostedForAllocation(tx, bankTxId, 'allocate');
  if (opts?.reallocation) {
    // reallocate_bank_transaction only (bankReallocationService): this line, reconciled on exactly that completed
    // reconciliation, judged on THIS locked row — in place of the D12 refusal and the 'imported' requirement.
    await assertReallocatableRow(companyId, tx, opts.reallocation);
  } else {
    await refuseLineOfCompletedReconciliation(companyId, tx); // D12: the shared 409, before the status refusal
    if (tx.status !== 'imported') {
      throw new BankAllocationRefusal(`Transaction already ${tx.status} — cannot allocate`);
    }
  }

  // WP2 row 5 (Hein): the line's own bank as an account contra posts nothing — refused from the locked row
  // (bankContraTransfer). An account contra that IS a bank account is rerouted below, once the plan has read it.
  refuseOwnBankContra(requestedAllocType, contraAccountId, String(tx.bank_account_id));
  let allocType = requestedAllocType;

  // R-067. `entityId` arrives in the request body (bank-transactions-action.ts:40
  // validates its UUID SHAPE only) and is written into `customer_payments.client_id`
  // below; the only customer read on this path fetches a NAME and falls back to
  // `Customer #<id>` on a miss. Measured: company A allocated a receipt against
  // company B's customer and the row carried B's client_id. Fenced in the service,
  // not the route — the two screens, bank-match-confirm and the MCP allocate /
  // bulk-allocate tools all pass through here — and BEFORE `createJournalEntry`,
  // because withAuth COMMITs a 4xx returned after a write. Supplier twin (R-068):
  // the supplier arm's name lookup falls back to `Supplier #<id>` the same way,
  // and recordSupplierBankPayment writes the id into supplier_payments.
  if (allocType === 'customer') await assertCustomerInCompany(companyId, entityId);
  if (allocType === 'supplier') await assertSupplierInCompany(companyId, entityId);

  const totalAmount = Math.abs(Number(tx.amount));
  const bankAccountId = String(tx.bank_account_id);
  // fmtDate, NOT toISOString(): pg hands the DATE back as a Date at LOCAL
  // midnight, and toISOString() re-reads it in UTC — on the UTC+2 box that
  // rolls 2026-03-01T00:30+02:00 back to "2026-02-28", dating the journal into
  // the previous month (and, at a boundary, into a closed period).
  const txDate = fmtDate(tx.transaction_date);
  const isSpent = Number(tx.amount) < 0;
  // R-035 PR5 (Hein, D2): money OUT to a supplier from a HAND-KEYED line is a
  // payment instruction, not bank evidence — refused (409) under an enforced
  // supplier_payment rule, from the locked row, before the first write.
  if (allocType === 'supplier' && entityId && isSpent) await assertBankLineMayPaySupplier(companyId, tx, totalAmount);
  if (allocType === 'account' || allocType === 'transfer') await assertBankLineMayPostToAccounts(companyId, tx, totalAmount); // R-035 PR6 H2
  await assertImporterMayAllocateAs(companyId, tx, userId, allocType, entityId); // step 2: not the statement's importer (403)

  // The contra account, the AP/AR-control refusal, the VAT split and the dimensions: reads only (bankAllocationPlan).
  const planFor = (type: AllocationType) => planAllocationPosting({
    companyId, bankTxId, allocType: type, contraAccountId, entityId, vatCode, cc1Id, cc2Id, buId,
    bankAccountId, totalAmount, isSpent,
  });
  let plan = await planFor(allocType);
  // WP2 row 5: an account contra that is a BANK account is a transfer — the duplicate guard, the pair lock and the leg
  // pairing apply (bankContraTransfer). Decided from the contra row the plan just read; a transfer re-plans with no SQL.
  if (isBankContraPlan(allocType, plan.contraRows)) { allocType = 'transfer'; plan = await planFor(allocType); }
  const { allocationDims } = plan;

  // The journal lines of each arm, with the arm's own pre-write refusals (bankAllocationArms).
  const { lines, source, entryDesc, allocEntityName, counterpartyAccountId } = await buildAllocationArm({
    companyId, tx, allocType, contraAccountId, entityId, description, bankAccountId, totalAmount, txDate, isSpent, plan,
  });

  const linesWithDims = stampContraDimensions(lines, allocType === 'account' ? contraAccountId : null, allocationDims);

  // Carry forward source_document_id from the invoice when allocating against a known entity
  const invoiceSourceDocId = await invoiceSourceDocumentOf(companyId, allocType, entityId);

  const allocationMeta: JournalEntryMeta = {
    // The actor rides with the stamp: an MCP caller supplies both, every other
    // caller supplies neither and the columns stay NULL (derived at read time).
    postingAgent: opts?.postingAgent ?? 'system:bank-allocation:v1',
    ...(opts?.actorType === undefined ? {} : { actorType: opts.actorType }),
    ...(opts?.actorTokenJti === undefined ? {} : { actorTokenJti: opts.actorTokenJti }),
    sourceDocumentId: invoiceSourceDocId,
  };

  // A transfer from a line with no statement or feed behind it (hand-keyed; a Sage-migrated line too) is a typed amount
  // like a Transfers-page one: the reference says so (only a journal the statement created is reference-less:
  // reports/journalSourceKinds, bank/transferDuplicateGuard — sec-nrfa r4 M1, brk-nrfa r6 L2).
  const reference = source === 'auto_bank_transfer' && !isBankEvidenced(tx) ? 'No statement or feed line' : undefined;
  const je = await createJournalEntry(companyId, {
    entryDate: txDate, description: entryDesc, source, lines: linesWithDims, reference,
  }, userId, allocationMeta, { allowLateInputClaim: opts?.allowLateInputClaim });
  const { lateClaim } = await postJournalEntry(companyId, je.id, userId, { allowLateInputClaim: opts?.allowLateInputClaim });

  // Resolve journal line id and optional customer payment user BEFORE opening tx (read-only lookups)
  const jeLines = (await sql`
    SELECT jl.id FROM gl_journal_lines jl
    WHERE jl.journal_entry_id = ${je.id}::UUID AND jl.gl_account_id = ${bankAccountId}::UUID
      AND jl.company_id = ${companyId}::UUID LIMIT 1`) as Row[];
  const journalLineId = jeLines.length > 0 ? String(jeLines[0]!.id) : null;

  // `!isSpent` here and on the INSERT below: a customer refund is cash going
  // OUT, and a `customer_payments` row for it is a RECEIPT the company never
  // received. It would surface in list_unapplied_receipts and on the customer
  // statement as real cash — the same orphan shape that put R1.84m of phantom
  // receipts on one statement — and the fallback lookup this guard also skips
  // is a query with no reason to run.
  let paymentUserId: string | null = null;
  if (allocType === 'customer' && entityId && !isSpent) {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidPattern.test(userId)) {
      paymentUserId = userId;
    } else {
      const fallback = (await sql`SELECT id FROM users WHERE id::TEXT ~ '^[0-9a-f]{8}-' LIMIT 1`) as Row[];
      paymentUserId = fallback.length > 0 ? String(fallback[0]!.id) : null;
    }
  }

  // Resolved once: both arms read it, and the response echoes it back so the
  // caller can show the user which mode produced the applications below.
  const autoApplyMode: AutoApplyMode = opts?.autoApply ?? DEFAULT_AUTO_APPLY;
  let customerPaymentId: string | null = null;
  // Atomically update bank_transactions and optionally insert the customer_payment record.
  // If either write fails the whole block rolls back — no orphaned allocation state.
  await withTransaction(async (wTx) => {
    if (journalLineId) {
      await wTx`
        UPDATE bank_transactions
        SET status = 'allocated', matched_journal_line_id = ${journalLineId}::UUID,
            allocation_type = ${allocType}, allocated_entity_name = ${allocEntityName},
            -- A manual allocation replaces whatever a rule did here.
            allocation_rule_id = NULL, allocation_rule_name = NULL,
            counterparty_account_id = ${counterpartyAccountId}::UUID,
            transfer_journal_entry_id = ${allocType === 'transfer' ? je.id : null}::UUID,
            cc1_id = ${allocationDims.cc1Id || null}::UUID, cc2_id = ${allocationDims.cc2Id || null}::UUID,
            bu_id = ${allocationDims.buId || null}::UUID, updated_at = NOW(),
            -- A fresh allocation is NOT part of whatever batch previously
            -- owned this row. Left set, reverse_bank_allocation_batch would
            -- reverse a journal its batch never posted (PR #263 review).
            allocation_batch_id = NULL,
            -- Nor does it pay the purchase order the line paid before (a re-pointed reconciled line): left set, that
            -- PO still counts this cash as paid. The PO match (confirmPurchaseOrderMatch, lane B's #1458) sets it again
            -- AFTER this call.
            linked_po_id = NULL
        WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`;
    }
    if (allocType === 'customer' && entityId && paymentUserId && !isSpent) {
      // Captured so the receipt can be APPLIED below. Before this the row was
      // inserted and its id thrown away, which is why every one of them landed
      // in list_unapplied_receipts.
      customerPaymentId = await insertCustomerBankReceipt(wTx, {
        companyId, customerId: entityId, paymentDate: txDate, amount: totalAmount,
        bankReference: (tx.reference || tx.bank_reference || tx.description || null) as string | null,
        bankAccountId, description: entryDesc, journalEntryId: je.id, createdBy: paymentUserId,
      });
    }
  });

  // The supplier payment / refund, the customer refund and the receipt's application (bankAllocationDocuments).
  const application = await recordAllocationDocuments({
    companyId, bankTxId, allocType, entityId, invoiceId, isSpent, totalAmount, autoApplyMode, bankAccountId,
    je, txDate, entryDesc, userId, customerPaymentId,
  });

  log.info('Allocated bank transaction', { bankTxId, journalEntryId: je.id, allocType, entityId, contraAccountId }, 'accounting');

  // Auto-link the counterparty bank_transaction if it already exists as 'imported'
  if (allocType === 'transfer' && counterpartyAccountId) {
    await autoLinkCounterpartyTransfer({
      companyId, bankTxId, bankAccountId, counterpartyAccountId,
      journalEntryId: je.id, amount: Number(tx.amount), txDate,
      allocatedEntityName: allocEntityName,
    });
  }

  // Learning loop (non-fatal): accepted vs recoded against the open suggestion. The gate's own post is
  // recorded by the gate as an auto-post, never as a person's decision.
  if (!opts?.unattended) {
    const byContact = allocType === 'supplier' || allocType === 'customer';
    await recordAllocationDecision(companyId, bankTxId, userId,
      { glAccountId: byContact ? null : contraAccountId, contactId: byContact ? entityId ?? null : null });
  }

  const updated = (await sql`SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
  return {
    journalEntryId: je.id,
    bankTransaction: mapTxRow(updated[0]!),
    ...(application ? { application } : {}),
    ...(lateClaim ? { lateClaim } : {}),
  };
}
