/**
 * PRD-060: FibreFlow Accounting Module — Phase 4
 * Bank Allocation Service — Sage Process Bank equivalent (allocate, split, reverse)
 */

import { sql, withTransaction } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import type { JournalEntryMeta } from '../gl/journalEntryMeta';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { mapTxRow } from './bankTransactionQueryService';
import type { BankTransaction } from '../../types/bank.types';
import type { JournalLineInput } from '../../types/gl.types';
import { recordPaymentMatch } from '../capture/fourWayMatchService';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { autoLinkCounterpartyTransfer } from './bankTransferAutoLink';

type Row = DbRow;

const SA_VAT_RATE_PCT = 15; // Standard SA VAT rate; update if SARS changes the statutory rate

// ── VAT account fallback resolver ──────────────────────────────────────────
//
// Migration 327 normalises account_subtype to 'vat_input' / 'vat_output'.
// If a company's COA pre-dates that migration, we fall back to the standard
// SA account codes (1140 / 2120).  If still not found, we throw a clear error.

const VAT_FALLBACK_CODES: Record<'vat_input' | 'vat_output', string> = {
  vat_input: '1140',
  vat_output: '2120',
};

async function resolveVatAccountId(
  key: 'vat_input' | 'vat_output',
  companyId: string,
): Promise<string> {
  try {
    return await getSystemAccountId(key, companyId);
  } catch {
    // Subtype lookup failed — try the well-known SA account code as fallback.
    const code = VAT_FALLBACK_CODES[key];
    const rows = (await sql`
      SELECT id FROM gl_accounts
      WHERE company_id = ${companyId}::UUID
        AND is_system_account = true
        AND account_code = ${code}
      LIMIT 1
    `) as Row[];
    if (rows.length > 0 && rows[0]!.id) {
      log.warn(
        `VAT account '${key}' found via account_code fallback (code=${code}); run migration 327 to normalise subtypes.`,
        { companyId },
        'accounting',
      );
      return String(rows[0]!.id);
    }
    throw new Error(
      `VAT Input system account not found for company ${companyId}. ` +
      `Create a system account with account_subtype='${key}' or account_code='${code}' (migration 327).`,
    );
  }
}

export type AllocationType = 'account' | 'supplier' | 'customer' | 'transfer';

export interface SplitLine {
  contraAccountId: string;
  amount: number;
  description?: string;
  vatCode?: string;
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
  opts?: { postingAgent?: string },
): Promise<{ journalEntryId: string; bankTransaction: BankTransaction }> {
  // FOR UPDATE: hold the row for the rest of the request so a concurrent
  // allocate blocks here rather than passing the same status check and posting
  // a second journal for one transaction.
  const tx = await lockBankTransactionForUpdate(companyId, bankTxId);
  if (!tx) throw new Error(`Bank transaction ${bankTxId} not found`);
  if (tx.status !== 'imported') throw new Error(`Transaction already ${tx.status} — cannot allocate`);

  const totalAmount = Math.abs(Number(tx.amount));
  const bankAccountId = String(tx.bank_account_id);
  // fmtDate, NOT toISOString(): pg hands the DATE back as a Date at LOCAL
  // midnight, and toISOString() re-reads it in UTC — on the UTC+2 box that
  // rolls 2026-03-01T00:30+02:00 back to "2026-02-28", dating the journal into
  // the previous month (and, at a boundary, into a closed period).
  const txDate = fmtDate(tx.transaction_date);
  const isSpent = Number(tx.amount) < 0;

  const hasVat = vatCode === 'standard';
  const vatRate = hasVat ? SA_VAT_RATE_PCT : 0;
  const netAmount = hasVat ? Math.round((totalAmount * 100 / (100 + SA_VAT_RATE_PCT)) * 100) / 100 : totalAmount;
  const vatAmount = hasVat ? Math.round((totalAmount - netAmount) * 100) / 100 : 0;
  const vatAccountKey = isSpent ? 'vat_input' as const : 'vat_output' as const;
  const mapVatType = vatCode === 'standard' ? 'standard' as const
    : vatCode === 'zero_rated' ? 'zero_rated' as const
    : vatCode === 'exempt' ? 'exempt' as const : undefined;

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
    if (String(cp.account_subtype) !== 'bank') {
      throw new Error('Transfer counterparty must be a bank account (subtype = bank)');
    }

    // Guard: if the opposite bank's feed already has an allocated transfer
    // matching this amount/date, the user is double-posting. Matching the
    // existing JE is the correct path.
    const dupRows = (await sql`
      SELECT id FROM bank_transactions
      WHERE company_id = ${companyId}::UUID
        AND bank_account_id = ${contraAccountId}::UUID
        AND counterparty_account_id = ${bankAccountId}::UUID
        AND transfer_journal_entry_id IS NOT NULL
        AND amount = ${-Number(tx.amount)}
        AND transaction_date BETWEEN (${txDate}::DATE - INTERVAL '2 days')
                                 AND (${txDate}::DATE + INTERVAL '2 days')
      LIMIT 1
    `) as Row[];
    if (dupRows.length > 0) {
      throw new Error(
        'A matching transfer already exists on the counterparty bank for this amount and date. ' +
        'Match the existing journal entry instead of posting a new one.',
      );
    }

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
    entryDesc = description || `Payment to ${supName}`;
    source = 'auto_supplier_payment';
    lines = [
      { glAccountId: apAccountId, debit: netAmount, credit: 0, description: entryDesc, vatType: mapVatType },
      { glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc },
    ];
    if (hasVat) {
      const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
      lines.splice(1, 0, { glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
    }
  } else if (allocType === 'customer' && entityId) {

    const arAccountId = await getSystemAccountId('receivable', companyId);
    const custRows = (await sql`SELECT name FROM customers WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
    const custName = custRows.length > 0 ? String(custRows[0]!.name) : `Customer #${entityId}`;
    allocEntityName = custName;
    entryDesc = description || `Receipt from ${custName}`;
    source = 'auto_payment';
    lines = [
      { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
      { glAccountId: arAccountId, debit: 0, credit: netAmount, description: entryDesc, vatType: mapVatType },
    ];
    if (hasVat) {
      const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
      lines.push({ glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
    }
  } else {
    if (!contraAccountId) throw new Error('contraAccountId is required for account allocation');
    const acctRows = (await sql`SELECT account_code, account_name FROM gl_accounts WHERE id = ${contraAccountId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
    allocEntityName = acctRows.length > 0 ? `${String(acctRows[0]!.account_code)} ${String(acctRows[0]!.account_name)}` : null;
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

  const linesWithDims = lines.map(l =>
    l.glAccountId === bankAccountId ? l : { ...l, costCenterId: cc1Id || l.costCenterId, buId: buId || l.buId }
  );

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
    postingAgent: opts?.postingAgent ?? 'system:bank-allocation:v1',
    sourceDocumentId: invoiceSourceDocId,
  };

  const je = await createJournalEntry(companyId, {
    entryDate: txDate, description: entryDesc, source, lines: linesWithDims,
  }, userId, allocationMeta);
  await postJournalEntry(companyId, je.id, userId);

  // Resolve journal line id and optional customer payment user BEFORE opening tx (read-only lookups)
  const jeLines = (await sql`
    SELECT jl.id FROM gl_journal_lines jl
    WHERE jl.journal_entry_id = ${je.id}::UUID AND jl.gl_account_id = ${bankAccountId}::UUID
      AND jl.company_id = ${companyId}::UUID LIMIT 1`) as Row[];
  const journalLineId = jeLines.length > 0 ? String(jeLines[0]!.id) : null;

  let paymentUserId: string | null = null;
  if (allocType === 'customer' && entityId) {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidPattern.test(userId)) {
      paymentUserId = userId;
    } else {
      const fallback = (await sql`SELECT id FROM users WHERE id::TEXT ~ '^[0-9a-f]{8}-' LIMIT 1`) as Row[];
      paymentUserId = fallback.length > 0 ? String(fallback[0]!.id) : null;
    }
  }

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
            cc1_id = ${cc1Id || null}::UUID, cc2_id = ${cc2Id || null}::UUID,
            bu_id = ${buId || null}::UUID, updated_at = NOW(),
            -- A fresh allocation is NOT part of whatever batch previously
            -- owned this row. Left set, reverse_bank_allocation_batch would
            -- reverse a journal its batch never posted (PR #263 review).
            allocation_batch_id = NULL
        WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`;
    }
    if (allocType === 'customer' && entityId && paymentUserId) {
      await wTx`
        INSERT INTO customer_payments (
          company_id, client_id, payment_date, total_amount, payment_method,
          bank_reference, bank_account_id, description, status,
          gl_journal_entry_id, created_by, confirmed_by, confirmed_at
        ) VALUES (
          ${companyId}::UUID, ${entityId}::UUID, ${txDate}, ${totalAmount}, 'eft',
          ${tx.reference || tx.bank_reference || tx.description || null},
          ${bankAccountId}::UUID, ${entryDesc}, 'confirmed',
          ${je.id}::UUID, ${paymentUserId}::UUID, ${paymentUserId}::UUID, NOW()
        )`;
    }
  });

  // 4-way match: prefer the explicit invoiceId (from bankMatchCandidates), fall
  // back to the most-recent unpaid invoice for the supplier. The explicit path
  // is correct when multiple invoices are outstanding; the fallback keeps older
  // call sites functional without requiring them to know the invoice.
  if (allocType === 'supplier' && entityId) {
    try {
      let targetInvoiceId: string | null = invoiceId ?? null;
      if (!targetInvoiceId) {
        const unpaidRows = (await sql`
          SELECT id FROM supplier_invoices
          WHERE company_id = ${companyId}::UUID
            AND supplier_id = ${entityId}::UUID
            AND payment_matched = false
            AND status NOT IN ('cancelled', 'paid')
          ORDER BY created_at DESC
          LIMIT 1
        `) as Row[];
        if (unpaidRows.length > 0 && unpaidRows[0]!.id) {
          targetInvoiceId = String(unpaidRows[0]!.id);
        }
      }
      if (targetInvoiceId) {
        await recordPaymentMatch(companyId, targetInvoiceId, totalAmount);
      }
    } catch (matchErr) {
      log.error('4-way match check failed — allocation still recorded', { bankTxId, entityId, invoiceId, error: matchErr }, 'accounting');
    }
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
  return { journalEntryId: je.id, bankTransaction: mapTxRow(updated[0]!) };
}

// ── Split Allocate ────────────────────────────────────────────────────────────

export async function splitAllocateTransaction(
  companyId: string, bankTxId: string, lines: SplitLine[], userId: string,
): Promise<{ journalEntryId: string; bankTransaction: BankTransaction }> {
  const tx = await lockBankTransactionForUpdate(companyId, bankTxId); // see allocateTransaction
  if (!tx) throw new Error(`Bank transaction ${bankTxId} not found`);
  if (tx.status !== 'imported') throw new Error(`Transaction already ${tx.status} — cannot split allocate`);
  if (!lines || lines.length === 0) throw new Error('At least one split line is required');

  const totalAmount = Math.abs(Number(tx.amount));
  const linesTotal = lines.reduce((sum, l) => sum + Number(l.amount), 0);
  if (Math.abs(linesTotal - totalAmount) > 0.01) {
    throw new Error(`Split lines total R${linesTotal.toFixed(2)} does not equal transaction amount R${totalAmount.toFixed(2)}`);
  }

  const bankAccountId = String(tx.bank_account_id);
  // fmtDate, NOT toISOString(): pg hands the DATE back as a Date at LOCAL
  // midnight, and toISOString() re-reads it in UTC — on the UTC+2 box that
  // rolls 2026-03-01T00:30+02:00 back to "2026-02-28", dating the journal into
  // the previous month (and, at a boundary, into a closed period).
  const txDate = fmtDate(tx.transaction_date);
  const isSpent = Number(tx.amount) < 0;
  const entryDesc = String(tx.description || 'Split bank allocation');
  const journalLines: JournalLineInput[] = [];

  for (const line of lines) {
    const lineAmount = Number(line.amount);
    const hasVat = line.vatCode === 'standard';
    const netAmount = hasVat ? Math.round((lineAmount * 100 / (100 + SA_VAT_RATE_PCT)) * 100) / 100 : lineAmount;
    const vatAmount = hasVat ? Math.round((lineAmount - netAmount) * 100) / 100 : 0;
    const vatAccountKey = isSpent ? 'vat_input' as const : 'vat_output' as const;
    const lineDesc = line.description || entryDesc;
    const mapVatType = line.vatCode === 'standard' ? 'standard' as const
      : line.vatCode === 'zero_rated' ? 'zero_rated' as const
      : line.vatCode === 'exempt' ? 'exempt' as const : undefined;
    if (isSpent) {
      journalLines.push({ glAccountId: line.contraAccountId, debit: netAmount, credit: 0, description: lineDesc, vatType: mapVatType });
      if (hasVat) {
        const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
        journalLines.push({ glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: 'VAT @ 15%', vatType: 'standard' });
      }
    } else {
      journalLines.push({ glAccountId: line.contraAccountId, debit: 0, credit: netAmount, description: lineDesc, vatType: mapVatType });
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

  const splitMeta: JournalEntryMeta = { postingAgent: 'system:bank-allocation:v1' };
  const je = await createJournalEntry(companyId, {
    entryDate: txDate, description: entryDesc, source: 'auto_bank_recon', lines: journalLines,
  }, userId, splitMeta);
  await postJournalEntry(companyId, je.id, userId);

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
  return { journalEntryId: je.id, bankTransaction: mapTxRow(updated[0]!) };
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
  companyId: string, bankTxId: string, userId: string,
  opts?: { postingAgent?: string; reversalDate?: string },
): Promise<void> {
  const tx = await lockBankTransactionForUpdate(companyId, bankTxId); // see allocateTransaction
  if (!tx) throw new Error('Transaction not found');
  if (tx.status !== 'allocated' && tx.status !== 'matched' && tx.status !== 'reconciled') {
    throw new Error('Can only reverse allocated, matched, or reconciled transactions');
  }
  let journalEntryId: string | null = null;
  if (tx.matched_journal_line_id) {
    const jlRows = (await sql`
      SELECT jl.journal_entry_id FROM gl_journal_lines jl
      WHERE jl.id = ${tx.matched_journal_line_id}::UUID AND jl.company_id = ${companyId}::UUID`) as Row[];
    if (jlRows.length > 0 && jlRows[0]!.journal_entry_id) {
      journalEntryId = String(jlRows[0]!.journal_entry_id);
      const { reverseJournalEntry } = await import('../gl/journalEntryService');
      try {
        await reverseJournalEntry(companyId, journalEntryId, userId, opts);
      } catch (e) {
        throw new Error(`Cannot reverse: ${e instanceof Error ? e.message : 'Journal reversal failed'}`);
      }
    }
  }

  // Reset the bank transaction. If this fails after a successful GL reversal,
  // log the inconsistency for manual correction.
  try {
    await sql`
      UPDATE bank_transactions
      SET status = 'imported', matched_journal_line_id = NULL, reconciliation_id = NULL,
          linked_po_id = NULL, allocation_type = NULL, allocated_entity_name = NULL,
          allocation_rule_id = NULL, allocation_rule_name = NULL,
          -- Reversing one line takes it OUT of its batch: the batch no longer
          -- owns a journal here, and a later re-allocation must not be swept
          -- up by reverse_bank_allocation_batch.
          allocation_batch_id = NULL,
          updated_at = NOW()
      WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`;
  } catch (resetErr) {
    log.error('Bank transaction reset failed after GL reversal — manual correction required',
      { bankTxId, journalEntryId, error: resetErr }, 'accounting');
    throw resetErr;
  }
  log.info('Reversed reconciled bank transaction', { bankTxId, userId }, 'accounting');
}
