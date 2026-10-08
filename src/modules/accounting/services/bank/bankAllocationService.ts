/**
 * PRD-060: FibreFlow Accounting Module — Phase 4
 * Bank Allocation Service — Sage Process Bank equivalent (allocate, split, reverse)
 */

import { reconciliationLockOf, refuseLineOfCompletedReconciliation, refuseLockedCash } from './reconciledCash';
import { sql, withSavepoint, withTransaction } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import type { LateClaimInfo } from '../gl/vatLateClaimPlan';
import type { JournalEntryMeta, PostingActorOpts } from '../gl/journalEntryMeta';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { resolveVatAccountId } from './bankVatAccountResolver';
import { isControlAccountSettlement } from '../gl/settlementVat';
import { isBankSubtype } from '../gl/accountSubtypes';
import { mapTxRow } from './bankTransactionQueryService';
import type { BankTransaction } from '../../types/bank.types';
import type { JournalLineInput } from '../../types/gl.types';
import { recordPaymentMatch } from '../capture/fourWayMatchService';
import { recordSupplierBankPayment } from '../ap/supplierAutoAllocate';
import { planSupplierRefund, recordSupplierRefund } from '../ap/supplierRefundDocument';
import { planCustomerRefund, recordCustomerRefund } from '../ar/customerRefundDocument';
import { autoApplyCustomerReceipt } from '../ar/customerAutoAllocate';
import { unwindBankAllocationApplication } from './bankAllocationUnwind';
import type { BankAllocationUnwindResult } from './bankAllocationUnwind';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { assertReversalDatePostable, entryDateOf, lockPeekedReversalTarget, peekReversalTarget } from './reversalDatePostable';
import { underFlowLockBudget } from '../core/rowLockBudget';
import { refuseResettingProvisionalLine } from './provisionalLineGuard';
import { isoDay, lockChainLines, peekLineChain, resetBankLine, reverseDocumentChainLine } from './bankChainLineReversal';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import { assertPostedForAllocation } from './bankFeedStateGuard';
import { autoLinkCounterpartyTransfer } from './bankTransferAutoLink';
import { assertCustomerInCompany, assertSupplierInCompany } from '../core/contactDirectoryService';
import { DEFAULT_AUTO_APPLY, type AutoApplyMode } from '../shared/autoAllocateStrategy';
import { assertBankLineMayPaySupplier, isBankEvidenced } from '../ap/bankLinePaymentGate';
import { assertBankLineMayPostToAccounts } from './bankLineJournalGate';
import { assertNoDuplicateTransfer } from './transferDuplicateGuard';
import { vatInclusiveSplit } from './bankVatInclusive';
import { isControlSubtype, planAllocationDimensions, stampContraDimensions } from './bankAllocationDimensions';
import { planSplitDimensions } from './bankSplitDimensions';


type Row = DbRow;


export type AllocationType = 'account' | 'supplier' | 'customer' | 'transfer';

/**
 * What a line's cash actually settled, for the caller to report back.
 *
 * Present on every supplier payment and customer receipt that named no
 * document — including under `auto_apply: 'none'`, where `applications` is
 * empty and `onAccount` is the whole line. A caller that cannot tell "applied
 * nothing" from "was never asked to" cannot explain the balance to its user.
 */
export interface AllocationApplicationResult {
  autoApply: AutoApplyMode;
  applications: { documentId: string; documentNumber: string; amount: number }[];
  /** The unapplied remainder left sitting on the contact's account. */
  onAccount: number;
}

export interface SplitLine {
  contraAccountId: string;
  amount: number;
  description?: string;
  vatCode?: string;
  /** Stamped on this line's contra (cost/revenue) line only — never on bank or VAT. */
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
}

// ── Allocate ──────────────────────────────────────────────────────────────────

/**
 * Allocate a bank transaction — Sage Process Bank equivalent.
 * Supports: account (GL), supplier (AP payment), customer (AR receipt).
 */
export async function allocateTransaction(
  companyId: string, bankTxId: string, contraAccountId: string | null, userId: string,
  description?: string, allocType: AllocationType = 'account', entityId?: string,
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
  opts?: PostingActorOpts & { autoApply?: AutoApplyMode; allowLateInputClaim?: boolean },
): Promise<{
  journalEntryId: string;
  bankTransaction: BankTransaction;
  /** Set when the allocation's input VAT was claimed late (s16(3)). */
  lateClaim?: LateClaimInfo;
  /** Present only for a supplier/customer line that named no document. */
  application?: AllocationApplicationResult;
}> {
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
  await refuseLineOfCompletedReconciliation(companyId, tx); // D12: the shared 409, before the status refusal
  if (tx.status !== 'imported') {
    throw new BankAllocationRefusal(`Transaction already ${tx.status} — cannot allocate`);
  }

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

  // This is the ATTENDED path: the screen (and the MCP tools behind it) warned
  // whoever chose this vat code — that an entertainment account normally denies
  // input tax (s17(2)(a)(i) means only they know whether the proviso applies to
  // their business), and that no supply can arise at all on a salary, tax,
  // distribution, depreciation, donation or exempt-financial account. So the
  // caller's choice stands here — nothing is coerced.
  //
  // THE UNATTENDED CALLERS GUARD BEFORE THEY CALL THIS, and there are THREE
  // of them — each found separately, which is the point of counting them here:
  //   1. `autoPostRuleLine` — the bank-rule sweep, takes the rule's vat_code.
  //   2. `autoPostGateService.sweep` — the confidence gate, LLM and
  //      categorisation tiers, posts `suggested_vat_code`.
  //   3. `provisionalPostingService.postProvisional` — the gate's import
  //      branch, which PREDICTS its own code from the most frequent one on
  //      that supplier's history, so a ledger already carrying a bad claim
  //      teaches it to repeat.
  // All three route through `gl/ruleVatResolution`. A fourth guards itself the
  // same way — do NOT move the coercion in here, or the attended path starts
  // silently overriding a user who was shown a warning and chose anyway.
  //
  // The account row is still read up front because the branch below needs it.
  // The same read also brings the contra's subtype and the bank account's (card's) default dimensions.
  const contraRows = (allocType === 'account' && contraAccountId)
    ? (await sql`
        SELECT a.account_code, a.account_name, a.account_subtype,
               b.default_cc1_id::TEXT AS bank_cc1_id, b.default_cc2_id::TEXT AS bank_cc2_id,
               b.default_bu_id::TEXT AS bank_bu_id
        FROM gl_accounts a
        LEFT JOIN gl_accounts b ON b.id = ${bankAccountId}::UUID AND b.company_id = ${companyId}::UUID
        WHERE a.id = ${contraAccountId}::UUID AND a.company_id = ${companyId}::UUID
      `) as Row[]
    : [];
  const effectiveVatCode = vatCode;

  // K-016: the supplier and customer arms SETTLE a document that already
  // carried its VAT, so no split may happen on them however the caller asked —
  // see `isControlAccountSettlement`. This is not the coercion the block above
  // forbids: nothing here overrides which ACCOUNT the user chose, and the
  // `account` arm (including a supplier/customer call with no entity, which
  // falls through to it) keeps the caller's code untouched.
  const isSettlement = isControlAccountSettlement(allocType) && Boolean(entityId);
  // Say so when a code actually goes away. The screen already renders N/A for
  // these types, so this is for the MCP tools and anyone reading the log after
  // the fact — a value the caller sent and the ledger did not use.
  if (isSettlement && effectiveVatCode && effectiveVatCode !== 'none') {
    log.info(
      'VAT code dropped: allocation settles a control account, not a supply',
      { companyId, bankTxId, allocType, requestedVatCode: effectiveVatCode },
      'accounting',
    );
  }

  // Brief §5.3: settlements and control-account lines carry no dimensions; card defaults fill the rest.
  // Decided here, from reads only, before the first write (bankAllocationDimensions.ts).
  const contraRow = contraRows[0];
  const allocationDims = planAllocationDimensions({
    settlement: isSettlement || allocType === 'transfer',
    contraIsControl: contraRow ? isControlSubtype(contraRow.account_subtype == null ? null : String(contraRow.account_subtype)) : false,
    explicit: { cc1Id, cc2Id, buId },
    bankDefaults: {
      cc1Id: contraRow?.bank_cc1_id ? String(contraRow.bank_cc1_id) : undefined,
      cc2Id: contraRow?.bank_cc2_id ? String(contraRow.bank_cc2_id) : undefined,
      buId: contraRow?.bank_bu_id ? String(contraRow.bank_bu_id) : undefined,
    },
  });

  const hasVat = effectiveVatCode === 'standard' && !isSettlement;
  const { vatRate, netAmount, vatAmount } = vatInclusiveSplit(totalAmount, hasVat);
  // Only the `account` branch can reach a VAT line now (K-016), and it has no
  // entity, so the direction IS the only signal: money out is a purchase (input
  // tax), money in is a supply (output tax).
  //
  // The supplier/customer arms used to pick the side from the alloc type rather
  // than the sign, because a supplier REFUND reverses INPUT tax however the
  // cash moved. That distinction has no line to land on any more — a settlement
  // posts no VAT at all — so the two arms no longer reach this.
  const vatAccountKey: 'vat_input' | 'vat_output' = isSpent ? 'vat_input' : 'vat_output';
  // A settlement leg must not carry a vat_type either: VAT201 reads that column,
  // so tagging the AP/AR leg 'standard' would declare the supply a second time
  // even with the VAT line gone.
  const mapVatType = isSettlement ? undefined
    : effectiveVatCode === 'standard' ? 'standard' as const
    : effectiveVatCode === 'zero_rated' ? 'zero_rated' as const
    : effectiveVatCode === 'exempt' ? 'exempt' as const : undefined;

  let lines: JournalLineInput[];
  let source: import('../../types/gl.types').GLEntrySource;
  let entryDesc = '';
  let allocEntityName: string | null = null;
  let counterpartyAccountId: string | null = null;

  if (allocType === 'transfer') {
    if (!contraAccountId) throw new Error('contraAccountId is required for transfer allocation (counterparty bank account)');
    if (contraAccountId === bankAccountId) throw new Error('Transfer source and destination bank accounts must differ');

    const cpRows = (await sql`
      SELECT account_code, account_name, account_subtype FROM gl_accounts
      WHERE id = ${contraAccountId}::UUID AND company_id = ${companyId}::UUID
    `) as Row[];
    if (cpRows.length === 0) throw new Error('Counterparty bank account not found');
    const cp = cpRows[0]!;
    if (!isBankSubtype(cp.account_subtype == null ? null : String(cp.account_subtype))) {
      throw new Error('Transfer counterparty must be a bank account (subtype = bank)');
    }

    // The same movement already in the ledger (the other bank's line, or a Banking > Transfers journal): refused.
    await assertNoDuplicateTransfer(companyId, bankAccountId, contraAccountId, Number(tx.amount), txDate,
      isBankEvidenced(tx));

    counterpartyAccountId = contraAccountId;
    allocEntityName = `${String(cp.account_code)} ${String(cp.account_name)}`;
    entryDesc = description || `Transfer: ${isSpent ? 'to' : 'from'} ${allocEntityName}`;
    source = 'auto_bank_transfer';

    // isSpent (outflow on this bank) → DR counterparty, CR this bank.
    // deposit (inflow on this bank) → DR this bank, CR counterparty.
    if (isSpent) {
      lines = [
        { glAccountId: contraAccountId, debit: totalAmount, credit: 0, description: entryDesc },
        { glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc },
      ];
    } else {
      lines = [
        { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
        { glAccountId: contraAccountId, debit: 0, credit: totalAmount, description: entryDesc },
      ];
    }
  } else if (allocType === 'supplier' && entityId) {
    const apAccountId = await getSystemAccountId('payable', companyId);
    const supRows = (await sql`SELECT name FROM suppliers WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
    const supName = supRows.length > 0 ? String(supRows[0]!.name) : `Supplier #${entityId}`;
    allocEntityName = supName;
    entryDesc = description || (isSpent ? `Payment to ${supName}` : `Refund from ${supName}`);
    source = 'auto_supplier_payment';
    // THE REFUND CEILING, DECIDED HERE AND NOT LOWER DOWN.
    //
    // A money-IN line against a supplier mints a refund document below, and a
    // refund cannot exceed the credit the supplier is holding — see
    // ap/supplierRefundDocument. This runs BEFORE `createJournalEntry`, which
    // is the first write on this path, because `withAuth` COMMITs on a 4xx and
    // rolls back only on a 5xx: a business refusal raised after the journal has
    // posted can only be answered by committing an orphan journal or by telling
    // the user an internal error occurred. Refused here there is nothing
    // written to unwind, and `BankAllocationRefusal` is the class the routes
    // already answer 400.
    if (!isSpent) await planSupplierRefund(companyId, entityId, totalAmount, txDate);
    // isSpent (money out) → a payment: DR AP, CR Bank.
    // deposit (money in)  → a refund:  DR Bank, CR AP.
    //
    // This branch ignored `isSpent` and always posted the payment direction, so
    // a refund credited the bank that the statement says was debited and the
    // account finished wrong by TWICE the line. Nothing failed: the call
    // returned success and the row read as allocated. R261,651.64 on Velocity
    // Fibre, found only by diffing the GL against the bank on signed amount.
    if (isSpent) {
      lines = [
        { glAccountId: apAccountId, debit: netAmount, credit: 0, description: entryDesc, vatType: mapVatType },
        { glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc },
      ];
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        lines.splice(1, 0, { glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
    } else {
      lines = [
        { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
        { glAccountId: apAccountId, debit: 0, credit: netAmount, description: entryDesc, vatType: mapVatType },
      ];
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        lines.push({ glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
    }
  } else if (allocType === 'customer' && entityId) {

    const arAccountId = await getSystemAccountId('receivable', companyId);
    const custRows = (await sql`SELECT name FROM customers WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
    const custName = custRows.length > 0 ? String(custRows[0]!.name) : `Customer #${entityId}`;
    allocEntityName = custName;
    entryDesc = description || (isSpent ? `Refund to ${custName}` : `Receipt from ${custName}`);
    source = 'auto_payment';
    // The mirror of the supplier arm's ceiling, and decided in the same place
    // and for the same reason: before `createJournalEntry`, which is the first
    // write on this path. See the note there.
    if (isSpent) await planCustomerRefund(companyId, entityId, totalAmount, txDate);
    // The mirror of the supplier arm, and it carried the mirror bug with no
    // occurrence yet: money OUT against a customer is a refund — DR AR, CR Bank
    // — and posting the receipt direction moved the bank the wrong way by twice
    // in exactly the same silence.
    if (isSpent) {
      lines = [
        { glAccountId: arAccountId, debit: netAmount, credit: 0, description: entryDesc, vatType: mapVatType },
        { glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc },
      ];
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        lines.splice(1, 0, { glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
    } else {
      lines = [
        { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
        { glAccountId: arAccountId, debit: 0, credit: netAmount, description: entryDesc, vatType: mapVatType },
      ];
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        lines.push({ glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
    }
  } else {
    if (!contraAccountId) throw new Error('contraAccountId is required for account allocation');
    allocEntityName = contraRows.length > 0
      ? `${String(contraRows[0]!.account_code)} ${String(contraRows[0]!.account_name)}` : null;
    entryDesc = description || String(tx.description || 'Bank allocation');
    source = 'auto_bank_recon';
    if (!isSpent) {
      lines = [
        { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
        { glAccountId: contraAccountId, debit: 0, credit: netAmount, description: entryDesc, vatType: mapVatType },
      ];
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        lines.push({ glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
    } else {
      lines = [{ glAccountId: contraAccountId, debit: netAmount, credit: 0, description: entryDesc, vatType: mapVatType }];
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        lines.push({ glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
      lines.push({ glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc });
    }
  }

  const linesWithDims = stampContraDimensions(lines, allocType === 'account' ? contraAccountId : null, allocationDims);

  // Carry forward source_document_id from the invoice when allocating against a known entity
  let invoiceSourceDocId: string | null = null;
  if (allocType === 'supplier' && entityId) {
    const invRows = (await sql`
      SELECT source_document_id FROM supplier_invoices
      WHERE company_id = ${companyId}::UUID AND supplier_id = ${entityId}::UUID
        AND source_document_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `) as Row[];
    invoiceSourceDocId = invRows.length > 0 && invRows[0]!.source_document_id
      ? String(invRows[0]!.source_document_id) : null;
  } else if (allocType === 'customer' && entityId) {
    const invRows = (await sql`
      SELECT source_document_id FROM customer_invoices
      WHERE company_id = ${companyId}::UUID
        AND COALESCE(client_id, customer_id) = ${entityId}::UUID
        AND source_document_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `) as Row[];
    invoiceSourceDocId = invRows.length > 0 && invRows[0]!.source_document_id
      ? String(invRows[0]!.source_document_id) : null;
  }

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
  let application: AllocationApplicationResult | undefined;
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
            allocation_batch_id = NULL
        WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`;
    }
    if (allocType === 'customer' && entityId && paymentUserId && !isSpent) {
      const inserted = (await wTx`
        INSERT INTO customer_payments (
          company_id, client_id, payment_date, total_amount, payment_method,
          bank_reference, bank_account_id, description, status,
          gl_journal_entry_id, created_by, confirmed_by, confirmed_at
        ) VALUES (
          ${companyId}::UUID, ${entityId}::UUID, ${txDate}, ${totalAmount}, 'eft',
          ${tx.reference || tx.bank_reference || tx.description || null},
          ${bankAccountId}::UUID, ${entryDesc}, 'confirmed',
          ${je.id}::UUID, ${paymentUserId}::UUID, ${paymentUserId}::UUID, NOW()
        )
        RETURNING id`) as Row[];
      // Captured so the receipt can be APPLIED below. Before this the row was
      // inserted and its id thrown away, which is why every one of them landed
      // in list_unapplied_receipts.
      customerPaymentId = inserted.length > 0 ? String(inserted[0]!.id) : null;
    }
  });

  // ── The supplier side of the cash ──────────────────────────────────────────
  //
  // TWO DIFFERENT THINGS, and conflating them is what broke this path.
  //
  // A caller that NAMES a bill is running the four-way match against that bill,
  // and `applyBankLineToSupplierInvoices` — which is the caller that names one
  // — owns the payment document and the application itself. Only the match flag
  // belongs here.
  //
  // A caller that names NO bill used to fall through to a lookup that took the
  // supplier's most recently CREATED unpaid bill and flagged it
  // `payment_matched` for the whole line, without moving `amount_paid` by a
  // cent — a settlement recorded against a bill nobody chose, on a payment
  // document that did not exist. That lookup is gone. The cash now gets the
  // document it always needed, and is applied only on the supplier's own
  // instruction (`auto_allocate_strategy`, migration 614).
  //
  // `isSpent` gates both: a refund is money coming back IN and is not a payment.
  if (allocType === 'supplier' && entityId && isSpent) {
    if (invoiceId) {
      try {
        await recordPaymentMatch(companyId, invoiceId, totalAmount);
      } catch (matchErr) {
        log.error('4-way match check failed — allocation still recorded', { bankTxId, entityId, invoiceId, error: matchErr }, 'accounting');
      }
    } else {
      // NOT caught. This writes, and a caught write is a partial commit under a
      // success response — see the header of ap/supplierAutoAllocate.ts.
      const recorded = await recordSupplierBankPayment({
        companyId,
        supplierId: entityId,
        // See the `autoApply` note on the signature: a caller that named a
        // target gets the document without the application.
        autoApply: autoApplyMode,
        bankTxId,
        bankAccountId,
        journalEntryId: je.id,
        amount: totalAmount,
        paymentDate: txDate,
        description: entryDesc,
        userId,
      });
      application = {
        autoApply: autoApplyMode,
        applications: recorded.appliedLines.map((l) => ({
          documentId: l.invoiceId, documentNumber: l.invoiceNumber, amount: l.amount,
        })),
        onAccount: recorded.unappliedRemainder,
      };
    }
  }

  // ── The refund: cash coming back ───────────────────────────────────────────
  //
  // The mirror of the arm above, and the half that did not exist. A money-IN
  // line against a supplier posted DR Bank / CR Accounts Payable and created no
  // document at all, so the control account moved, the subledger did not, and
  // the supplier's on-account credit stayed overstated by the whole refund.
  //
  // NEVER APPLIED, at any `autoApply` mode. The document is a NEGATIVE
  // remainder; "applying" it to a bill would un-pay that bill, which is a
  // correction a person makes deliberately and not something a sweep decides.
  // That is why there is no `autoApply` parameter here rather than one set to
  // 'none'.
  //
  // `invoiceId` is deliberately not consulted. On the payment arm it says a
  // caller has already claimed the document; no caller names a bill for a
  // refund, and if one ever did, the bill is not what the cash settles.
  // The customer mirror: money OUT to a customer, DR Accounts Receivable / CR
  // Bank. Same hole, same shape, opposite side — and the `!isSpent` gate on the
  // receipt insert above is what left it open. That gate is right and stays:
  // a POSITIVE receipt row for a refund is cash the company never received.
  if (allocType === 'customer' && entityId && isSpent) {
    const refund = await recordCustomerRefund({
      companyId, customerId: entityId, bankTxId, bankAccountId,
      journalEntryId: je.id, amount: totalAmount, paymentDate: txDate,
      description: entryDesc, userId,
    });
    application = { autoApply: 'none', applications: [], onAccount: refund.amount };
  }

  if (allocType === 'supplier' && entityId && !isSpent) {
    const refund = await recordSupplierRefund({
      companyId, supplierId: entityId, bankTxId, bankAccountId,
      journalEntryId: je.id, amount: totalAmount, paymentDate: txDate,
      description: entryDesc, userId,
    });
    application = {
      autoApply: 'none',
      applications: [],
      onAccount: refund.amount,
    };
  }

  // The receipt's own application, on the same rule and the same instruction.
  // The document already existed on this side; the instruction to apply it was
  // written to a column nothing read.
  //
  // `!invoiceId` and `opts?.autoApply` carry the SAME meaning as on the
  // supplier arm above, and leaving them off this arm was a real defect:
  //
  //   · `confirmReceiptMatch` passes an invoiceId and then applies the very
  //     payment this function created (it re-reads it by journal id). Applying
  //     it here first consumes the remainder, and its own
  //     `planReceiptApplication` then refuses — "only R0.00 of this receipt is
  //     unapplied" — so a bank receipt match would simply stop working for any
  //     customer with a strategy set.
  //   · `bank-match-confirm`'s customer branch names an invoice but passes no
  //     id, and writes `amount_paid` on it ABSOLUTELY from a value read before
  //     this call. If the strategy settled an older invoice, both writes stand
  //     and the subledger drops by twice the receipt. It passes
  //     `autoApply: false`.
  if (allocType === 'customer' && entityId && customerPaymentId && !isSpent && !invoiceId) {
    const applied = await autoApplyCustomerReceipt({
      companyId,
      customerId: entityId,
      paymentId: customerPaymentId,
      journalEntryId: je.id,
      amount: totalAmount,
      userId,
      autoApply: autoApplyMode,
    });
    application = {
      autoApply: autoApplyMode,
      applications: applied.appliedLines.map((l) => ({
        documentId: l.invoiceId, documentNumber: l.invoiceNumber, amount: l.amount,
      })),
      onAccount: applied.unappliedRemainder,
    };
  }

  log.info('Allocated bank transaction', { bankTxId, journalEntryId: je.id, allocType, entityId, contraAccountId }, 'accounting');

  // Auto-link the counterparty bank_transaction if it already exists as 'imported'
  if (allocType === 'transfer' && counterpartyAccountId) {
    await autoLinkCounterpartyTransfer({
      companyId, bankTxId, bankAccountId, counterpartyAccountId,
      journalEntryId: je.id, amount: Number(tx.amount), txDate,
      allocatedEntityName: allocEntityName,
    });
  }

  const updated = (await sql`SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
  return {
    journalEntryId: je.id,
    bankTransaction: mapTxRow(updated[0]!),
    ...(application ? { application } : {}),
    ...(lateClaim ? { lateClaim } : {}),
  };
}

// ── Split Allocate ────────────────────────────────────────────────────────────

export async function splitAllocateTransaction(
  companyId: string, bankTxId: string, lines: SplitLine[], userId: string,
  // allowLateInputClaim: a USER's split only — see allocateTransaction. The actor fields stamp an MCP split.
  opts?: PostingActorOpts & { allowLateInputClaim?: boolean },
): Promise<{
  journalEntryId: string; bankTransaction: BankTransaction; lateClaim?: LateClaimInfo;
  /** COS split lines with no project (CC2), when the company does not block them. */
  dimensionWarnings?: string[];
}> {
  const tx = await lockBankTransactionForUpdate(companyId, bankTxId); // see allocateTransaction
  // Same two pre-write refusals as `allocateTransaction`, and the same class:
  // both are decided from the locked row before anything is written, so a
  // caller that can show that ordering may answer them with a 4xx. Left as bare
  // Errors here they would have to be told apart by message text — which is
  // exactly what `BankAllocationRefusal` exists to stop.
  if (!tx) throw new BankAllocationRefusal(`Bank transaction ${bankTxId} not found`);
  // Same reasoning as allocateTransaction: refused from the locked row, before
  // any write, because status alone would let a pending/removed row through.
  assertPostedForAllocation(tx, bankTxId, 'split allocate');
  await refuseLineOfCompletedReconciliation(companyId, tx); // D12: the shared 409, before the status refusal
  if (tx.status !== 'imported') {
    throw new BankAllocationRefusal(`Transaction already ${tx.status} — cannot split allocate`);
  }
  if (!lines || lines.length === 0) throw new Error('At least one split line is required');

  const totalAmount = Math.abs(Number(tx.amount));
  const linesTotal = lines.reduce((sum, l) => sum + Number(l.amount), 0);
  if (Math.abs(linesTotal - totalAmount) > 0.01) {
    throw new Error(`Split lines total R${linesTotal.toFixed(2)} does not equal transaction amount R${totalAmount.toFixed(2)}`);
  }
  await assertBankLineMayPostToAccounts(companyId, tx, totalAmount); // R-035 PR6 H2: every split line is a GL account

  const bankAccountId = String(tx.bank_account_id);
  // fmtDate, NOT toISOString(): pg hands the DATE back as a Date at LOCAL
  // midnight, and toISOString() re-reads it in UTC — on the UTC+2 box that
  // rolls 2026-03-01T00:30+02:00 back to "2026-02-28", dating the journal into
  // the previous month (and, at a boundary, into a closed period).
  const txDate = fmtDate(tx.transaction_date);
  const isSpent = Number(tx.amount) < 0;
  const entryDesc = String(tx.description || 'Split bank allocation');
  const journalLines: JournalLineInput[] = [];
  // Reads only: refusals (dimensions on a control account, COS with no project where required) precede every write.
  const dimensionPlan = await planSplitDimensions(companyId, bankAccountId, lines);

  for (const [lineIndex, line] of lines.entries()) {
    const lineDims = dimensionPlan.dims[lineIndex] ?? {};
    const lineAmount = Number(line.amount);
    // Attended path, same as allocateTransaction: the split modal warned, the
    // user chose. Not coerced here.
    const lineVatCode = line.vatCode;
    const hasVat = lineVatCode === 'standard';
    const { netAmount, vatAmount } = vatInclusiveSplit(lineAmount, hasVat);
    // A split line is always a GL account — the split path has no entity — so
    // here the direction genuinely IS the only signal available.
    const vatAccountKey = isSpent ? 'vat_input' as const : 'vat_output' as const;
    const lineDesc = line.description || entryDesc;
    const mapVatType = lineVatCode === 'standard' ? 'standard' as const
      : lineVatCode === 'zero_rated' ? 'zero_rated' as const
      : lineVatCode === 'exempt' ? 'exempt' as const : undefined;
    if (isSpent) {
      journalLines.push({ glAccountId: line.contraAccountId, debit: netAmount, credit: 0, description: lineDesc, vatType: mapVatType, ...lineDims });
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        journalLines.push({ glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: 'VAT @ 15%', vatType: 'standard' });
      }
    } else {
      journalLines.push({ glAccountId: line.contraAccountId, debit: 0, credit: netAmount, description: lineDesc, vatType: mapVatType, ...lineDims });
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        journalLines.push({ glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: 'VAT @ 15%', vatType: 'standard' });
      }
    }
  }

  if (isSpent) {
    journalLines.push({ glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc });
  } else {
    journalLines.unshift({ glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc });
  }

  const splitMeta: JournalEntryMeta = {
    postingAgent: opts?.postingAgent ?? 'system:bank-allocation:v1',
    ...(opts?.actorType === undefined ? {} : { actorType: opts.actorType }),
    ...(opts?.actorTokenJti === undefined ? {} : { actorTokenJti: opts.actorTokenJti }),
  };
  const je = await createJournalEntry(companyId, {
    entryDate: txDate, description: entryDesc, source: 'auto_bank_recon', lines: journalLines,
  }, userId, splitMeta, { allowLateInputClaim: opts?.allowLateInputClaim });
  const { lateClaim } = await postJournalEntry(companyId, je.id, userId, { allowLateInputClaim: opts?.allowLateInputClaim });

  const jeLines = (await sql`
    SELECT jl.id FROM gl_journal_lines jl
    WHERE jl.journal_entry_id = ${je.id}::UUID AND jl.gl_account_id = ${bankAccountId}::UUID
      AND jl.company_id = ${companyId}::UUID LIMIT 1`) as Row[];
  const journalLineId = jeLines.length > 0 ? String(jeLines[0]!.id) : null;

  // Wrap the final bank_transactions write atomically
  if (journalLineId) {
    await withTransaction(async (wTx) => {
      await wTx`
        UPDATE bank_transactions
        SET status = 'allocated', matched_journal_line_id = ${journalLineId}::UUID,
            allocation_type = 'account', allocated_entity_name = 'Split allocation', updated_at = NOW(),
            allocation_rule_id = NULL, allocation_rule_name = NULL,
            allocation_batch_id = NULL
        WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`;
    });
  }

  log.info('Split-allocated bank transaction', { bankTxId, journalEntryId: je.id, lineCount: lines.length }, 'accounting');
  const updated = (await sql`SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
  return {
    journalEntryId: je.id, bankTransaction: mapTxRow(updated[0]!), ...(lateClaim ? { lateClaim } : {}),
    ...(dimensionPlan.warnings.length > 0 ? { dimensionWarnings: dimensionPlan.warnings } : {}),
  };
}

// ── Reverse Reconciled ────────────────────────────────────────────────────────

/**
 * Undo an allocation: post the contra for the matched journal, then return the
 * bank transaction to 'imported'.
 *
 * `opts.postingAgent` is forwarded to the contra journal so an automated caller
 * (MCP) can attribute its own correction. Omitting opts — every REST and
 * auto-post-undo call site — leaves the contra on the `human:<userId>` default.
 */
export async function reverseReconciledTransaction(
  companyId: string, bankTxId: string, userId: string, opts?: PostingActorOpts & { reversalDate?: string },
): Promise<BankAllocationUnwindResult> { // every lock under ONE budget, plain UPDATEs included (D8 round 10)
  return underFlowLockBudget(`Bank transaction ${bankTxId}`, () => reverseReconciledInner(companyId, bankTxId, userId, opts));
}
async function reverseReconciledInner(
  companyId: string, bankTxId: string, userId: string, opts?: PostingActorOpts & { reversalDate?: string },
): Promise<BankAllocationUnwindResult> {
  // D10: the line's journal is read through its chain's ROOT, which a document carries. A document's chain has every
  // statement line of it locked FIRST, in id order with this one (bank/bankChainLineReversal), as the HTTP void does.
  const chain = await peekLineChain(companyId, bankTxId);
  const chainLines = chain?.doc ? await lockChainLines(companyId, chain) : [];
  const tx = await lockBankTransactionForUpdate(companyId, bankTxId); // see allocateTransaction
  if (!tx) throw new Error('Transaction not found');
  // D10 O9 (with R-127's settled case): a provisional's own line is refused while its journal stands; one whose
  // journal the GL already took out is only freed below, its link cleared, nothing posted.
  const deadProvisional = await refuseResettingProvisionalLine(companyId, tx, 'reverse');
  // Changed since the peek (matched, unmatched or re-matched by another request): a state conflict, nothing written,
  // 409 — before the status refusal, which would otherwise answer an unmatch in between as a 400.
  if (String(tx.matched_journal_line_id ?? '') !== (chain?.lineId ?? '')) {
    throw new BankAllocationRefusal('This bank line was changed by another request while it was being reversed — retry in a moment.',
      undefined, { retryable: true });
  }
  if (!deadProvisional && tx.status !== 'allocated' && tx.status !== 'matched' && tx.status !== 'reconciled') {
    throw new Error('Can only reverse allocated, matched, or reconciled transactions');
  }
  // Cash on a COMPLETED reconciliation (or reconciled in the Sage import) is
  // locked — the shared rule void and batch reversal apply. Reversing it here
  // changed a completed reconciliation's figures with the reconciliation still
  // reading "completed". Before any write, so every caller answers it 400.
  refuseLockedCash(await reconciliationLockOf(companyId, tx), 'This bank line');
  if (chain?.doc) return reverseDocumentChainLine(companyId, tx, { ...chain, doc: chain.doc }, chainLines, userId, opts);
  // A plain journal: its chain decided from the root (D10), so a line on a middle or head reversal reverses the head
  // exactly when the chain stands. Its other lines stay as they are (a transfer's second leg: not D10).
  const journalEntryId = chain?.rootId ?? null;
  const reverseId = journalEntryId ? await peekReversalTarget(companyId, journalEntryId) : null; // locked after the unwind
  if (reverseId) await assertReversalDatePostable(companyId, reverseId, opts?.reversalDate); // read-only, pre-write
  // The contra defaults to the date of the journal it reverses (D8: the chain head); date_moved compares to it.
  const originalEntryDate = journalEntryId ? isoDay(await entryDateOf(companyId, reverseId ?? journalEntryId)) : null;

  // Every WRITE below runs inside one savepoint. The unwind has to precede the
  // contra (see the comment on it), so without this a throw from the contra
  // leaves the subledger unwound with the cash journal still standing — and a
  // 400 from the route COMMITs that. Rolling the pair back together is what
  // makes a refusal mean "nothing happened"; the bank-line reset joins them so
  // a failure there cannot strand a reset line either.
  //
  // This depends on there BEING a request transaction (withSavepoint degrades to a bare fn() outside one);
  // lockBankTransactionForUpdate above throws outside one, which is what keeps this guarantee true.
  const unwound = await withSavepoint('bank_reverse_reconciled', async () => {
    let result: BankAllocationUnwindResult = {
      invoicesReopened: 0, amountUnapplied: 0, paymentsCancelled: 0,
    };
    if (journalEntryId) {
      // BEFORE the contra is posted, not after. A line that named an invoice
      // moved the subledger; reversing the journal while that stands returns
      // the credit to the control account with the invoice still reading as
      // settled, which widens the subledger-to-control gap behind an
      // ordinary-looking reversal.
      result = await unwindBankAllocationApplication(companyId, journalEntryId);
      await lockPeekedReversalTarget(companyId, journalEntryId, reverseId); // the journal locked last (D8 round 6)
      const { reverseJournalEntry } = await import('../gl/journalEntryService');
      try {
        const reversal = reverseId ? await reverseJournalEntry(companyId, reverseId, userId, opts) : null;
        // Carried out so reverse_bank_allocation / void_receipt can say the contra was dated past a locked VAT
        // period and, with the two dates, that a CLOSED fiscal period moved it to today
        // (2026-10-02: nine April-2025 contras landed in October while the reply
        // said nothing had moved). A chain already out (D8) posts no contra: no date.
        result = {
          ...result, vatLockRoll: reversal?.vatLockRoll ?? null,
          originalEntryDate, reversalEntryDate: reversal ? isoDay(reversal.entryDate) : null,
        };
      } catch (e) {
        // A CODED refusal (VatPeriodLockedError and its kin: a string code that
        // is not a 5-character SQLSTATE) passes through as itself — rewrapped,
        // it lost the class routes map to 4xx and the code MCP surfaces.
        const code = (e as { code?: unknown } | null)?.code;
        if (e instanceof Error && typeof code === 'string' && !/^[0-9A-Z]{5}$/.test(code)) throw e;
        throw new Error(`Cannot reverse: ${e instanceof Error ? e.message : 'Journal reversal failed'}`);
      }
    }

    // Reset the bank transaction. If this fails after a successful GL reversal,
    // log the inconsistency; the savepoint then takes the reversal back with it.
    try {
      await resetBankLine(companyId, bankTxId, deadProvisional);
    } catch (resetErr) {
      log.error('Bank transaction reset failed after GL reversal — rolling the reversal back',
        { bankTxId, journalEntryId, error: resetErr }, 'accounting');
      throw resetErr;
    }
    return result;
  });
  log.info('Reversed reconciled bank transaction', { bankTxId, userId }, 'accounting');
  // Reported rather than discarded: `void_receipt` delegates to this function
  // and previously had to answer "0 invoices reopened" for the branch that does
  // the MOST work, because the counts were computed here and thrown away. An
  // agent reading that reply concludes nothing was undone and re-applies the
  // receipt. Callers that do not care keep ignoring the return value.
  return unwound;
}
