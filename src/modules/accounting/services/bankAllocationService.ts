/**
 * PRD-060: FibreFlow Accounting Module — Phase 4
 * Bank Allocation Service — Sage Process Bank equivalent (allocate, split, reverse)
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import { getSystemAccountId } from './systemAccountResolver';
import { mapTxRow } from './bankTransactionQueryService';
import type { BankTransaction } from '../types/bank.types';
import type { JournalLineInput } from '../types/gl.types';

type Row = Record<string, unknown>;

export type AllocationType = 'account' | 'supplier' | 'customer';

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
): Promise<{ journalEntryId: string; bankTransaction: BankTransaction }> {
  const txRows = (await sql`SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID`) as Row[];
  if (txRows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);
  const tx = txRows[0]!;
  if (tx.status !== 'imported') throw new Error(`Transaction already ${tx.status} — cannot allocate`);

  const totalAmount = Math.abs(Number(tx.amount));
  const bankAccountId = String(tx.bank_account_id);
  const txDate = tx.transaction_date instanceof Date
    ? (tx.transaction_date.toISOString().split('T')[0] ?? '')
    : (String(tx.transaction_date).split('T')[0] ?? '');
  const isSpent = Number(tx.amount) < 0;

  const hasVat = vatCode === 'standard';
  const vatRate = hasVat ? 15 : 0;
  const netAmount = hasVat ? Math.round((totalAmount * 100 / 115) * 100) / 100 : totalAmount;
  const vatAmount = hasVat ? Math.round((totalAmount - netAmount) * 100) / 100 : 0;
  const vatAccountKey = isSpent ? 'vat_input' as const : 'vat_output' as const;
  const mapVatType = vatCode === 'standard' ? 'standard' as const
    : vatCode === 'zero_rated' ? 'zero_rated' as const
    : vatCode === 'exempt' ? 'exempt' as const : undefined;

  let lines: JournalLineInput[];
  let source: import('../types/gl.types').GLEntrySource;
  let entryDesc = '';
  let allocEntityName: string | null = null;

  if (allocType === 'supplier' && entityId) {
    const apAccountId = await getSystemAccountId('payable');
    const supRows = (await sql`SELECT name FROM suppliers WHERE id = ${entityId}::UUID`) as Row[];
    const supName = supRows.length > 0 ? String(supRows[0]!.name) : `Supplier #${entityId}`;
    allocEntityName = supName;
    entryDesc = description || `Payment to ${supName}`;
    source = 'auto_supplier_payment';
    lines = [
      { glAccountId: apAccountId, debit: netAmount, credit: 0, description: entryDesc, vatType: mapVatType },
      { glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc },
    ];
    if (hasVat) {
      const vatAcctId = await getSystemAccountId(vatAccountKey);
      lines.splice(1, 0, { glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
    }
  } else if (allocType === 'customer' && entityId) {
    const arAccountId = await getSystemAccountId('receivable');
    const custRows = (await sql`SELECT name FROM customers WHERE id = ${entityId}::UUID`) as Row[];
    const custName = custRows.length > 0 ? String(custRows[0]!.name) : `Customer #${entityId}`;
    allocEntityName = custName;
    entryDesc = description || `Receipt from ${custName}`;
    source = 'auto_payment';
    lines = [
      { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
      { glAccountId: arAccountId, debit: 0, credit: netAmount, description: entryDesc, vatType: mapVatType },
    ];
    if (hasVat) {
      const vatAcctId = await getSystemAccountId(vatAccountKey);
      lines.push({ glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
    }
  } else {
    if (!contraAccountId) throw new Error('contraAccountId is required for account allocation');
    const acctRows = (await sql`SELECT account_code, account_name FROM gl_accounts WHERE id = ${contraAccountId}::UUID`) as Row[];
    allocEntityName = acctRows.length > 0 ? `${String(acctRows[0]!.account_code)} ${String(acctRows[0]!.account_name)}` : null;
    entryDesc = description || String(tx.description || 'Bank allocation');
    source = 'auto_bank_recon';
    if (!isSpent) {
      lines = [
        { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
        { glAccountId: contraAccountId, debit: 0, credit: netAmount, description: entryDesc, vatType: mapVatType },
      ];
      if (hasVat) {
        const vatAcctId = await getSystemAccountId(vatAccountKey);
        lines.push({ glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
    } else {
      lines = [{ glAccountId: contraAccountId, debit: netAmount, credit: 0, description: entryDesc, vatType: mapVatType }];
      if (hasVat) {
        const vatAcctId = await getSystemAccountId(vatAccountKey);
        lines.push({ glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
      lines.push({ glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc });
    }
  }

  const linesWithDims = lines.map(l =>
    l.glAccountId === bankAccountId ? l : { ...l, costCenterId: cc1Id || l.costCenterId, buId: buId || l.buId }
  );

  const je = await createJournalEntry(companyId, {
    entryDate: txDate, description: entryDesc, source, sourceDocumentId: bankTxId, lines: linesWithDims,
  }, userId);
  await postJournalEntry(companyId, je.id, userId);

  const jeLines = (await sql`
    SELECT id FROM gl_journal_lines
    WHERE journal_entry_id = ${je.id}::UUID AND gl_account_id = ${bankAccountId}::UUID LIMIT 1`) as Row[];
  const journalLineId = jeLines.length > 0 ? String(jeLines[0]!.id) : null;

  if (journalLineId) {
    await sql`
      UPDATE bank_transactions
      SET status = 'allocated', matched_journal_line_id = ${journalLineId}::UUID,
          allocation_type = ${allocType}, allocated_entity_name = ${allocEntityName},
          cc1_id = ${cc1Id || null}::UUID, cc2_id = ${cc2Id || null}::UUID,
          bu_id = ${buId || null}::UUID, updated_at = NOW()
      WHERE id = ${bankTxId}::UUID`;
  }

  if (allocType === 'customer' && entityId) {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let paymentUserId: string | null = userId;
    if (!uuidPattern.test(userId)) {
      const fallback = (await sql`SELECT id FROM users WHERE id::TEXT ~ '^[0-9a-f]{8}-' LIMIT 1`) as Row[];
      paymentUserId = fallback.length > 0 ? String(fallback[0]!.id) : null;
    }
    if (paymentUserId) {
      await sql`
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
  }

  log.info('Allocated bank transaction', { bankTxId, journalEntryId: je.id, allocType, entityId, contraAccountId }, 'accounting');
  const updated = (await sql`SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID`) as Row[];
  return { journalEntryId: je.id, bankTransaction: mapTxRow(updated[0]!) };
}

// ── Split Allocate ────────────────────────────────────────────────────────────

export async function splitAllocateTransaction(
  companyId: string, bankTxId: string, lines: SplitLine[], userId: string,
): Promise<{ journalEntryId: string; bankTransaction: BankTransaction }> {
  const txRows = (await sql`SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID`) as Row[];
  if (txRows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);
  const tx = txRows[0]!;
  if (tx.status !== 'imported') throw new Error(`Transaction already ${tx.status} — cannot split allocate`);
  if (!lines || lines.length === 0) throw new Error('At least one split line is required');

  const totalAmount = Math.abs(Number(tx.amount));
  const linesTotal = lines.reduce((sum, l) => sum + Number(l.amount), 0);
  if (Math.abs(linesTotal - totalAmount) > 0.01) {
    throw new Error(`Split lines total R${linesTotal.toFixed(2)} does not equal transaction amount R${totalAmount.toFixed(2)}`);
  }

  const bankAccountId = String(tx.bank_account_id);
  const txDate = tx.transaction_date instanceof Date
    ? (tx.transaction_date.toISOString().split('T')[0] ?? '')
    : (String(tx.transaction_date).split('T')[0] ?? '');
  const isSpent = Number(tx.amount) < 0;
  const entryDesc = String(tx.description || 'Split bank allocation');
  const journalLines: JournalLineInput[] = [];

  for (const line of lines) {
    const lineAmount = Number(line.amount);
    const hasVat = line.vatCode === 'standard';
    const netAmount = hasVat ? Math.round((lineAmount * 100 / 115) * 100) / 100 : lineAmount;
    const vatAmount = hasVat ? Math.round((lineAmount - netAmount) * 100) / 100 : 0;
    const vatAccountKey = isSpent ? 'vat_input' as const : 'vat_output' as const;
    const lineDesc = line.description || entryDesc;
    const mapVatType = line.vatCode === 'standard' ? 'standard' as const
      : line.vatCode === 'zero_rated' ? 'zero_rated' as const
      : line.vatCode === 'exempt' ? 'exempt' as const : undefined;
    if (isSpent) {
      journalLines.push({ glAccountId: line.contraAccountId, debit: netAmount, credit: 0, description: lineDesc, vatType: mapVatType });
      if (hasVat) {
        const vatAcctId = await getSystemAccountId(vatAccountKey);
        journalLines.push({ glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: 'VAT @ 15%', vatType: 'standard' });
      }
    } else {
      journalLines.push({ glAccountId: line.contraAccountId, debit: 0, credit: netAmount, description: lineDesc, vatType: mapVatType });
      if (hasVat) {
        const vatAcctId = await getSystemAccountId(vatAccountKey);
        journalLines.push({ glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: 'VAT @ 15%', vatType: 'standard' });
      }
    }
  }

  if (isSpent) {
    journalLines.push({ glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc });
  } else {
    journalLines.unshift({ glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc });
  }

  const je = await createJournalEntry(companyId, {
    entryDate: txDate, description: entryDesc, source: 'auto_bank_recon', sourceDocumentId: bankTxId, lines: journalLines,
  }, userId);
  await postJournalEntry(companyId, je.id, userId);

  const jeLines = (await sql`
    SELECT id FROM gl_journal_lines
    WHERE journal_entry_id = ${je.id}::UUID AND gl_account_id = ${bankAccountId}::UUID LIMIT 1`) as Row[];
  const journalLineId = jeLines.length > 0 ? String(jeLines[0]!.id) : null;

  if (journalLineId) {
    await sql`
      UPDATE bank_transactions
      SET status = 'allocated', matched_journal_line_id = ${journalLineId}::UUID,
          allocation_type = 'account', allocated_entity_name = 'Split allocation', updated_at = NOW()
      WHERE id = ${bankTxId}::UUID`;
  }

  log.info('Split-allocated bank transaction', { bankTxId, journalEntryId: je.id, lineCount: lines.length }, 'accounting');
  const updated = (await sql`SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID`) as Row[];
  return { journalEntryId: je.id, bankTransaction: mapTxRow(updated[0]!) };
}

// ── Reverse Reconciled ────────────────────────────────────────────────────────

export async function reverseReconciledTransaction(
  companyId: string, bankTxId: string, userId: string
): Promise<void> {
  const txRows = (await sql`SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID`) as Row[];
  const tx = txRows[0];
  if (!tx) throw new Error('Transaction not found');
  if (tx.status !== 'allocated' && tx.status !== 'matched' && tx.status !== 'reconciled') {
    throw new Error('Can only reverse allocated, matched, or reconciled transactions');
  }
  if (tx.matched_journal_line_id) {
    const jlRows = (await sql`
      SELECT journal_entry_id FROM gl_journal_lines WHERE id = ${tx.matched_journal_line_id}::UUID`) as Row[];
    if (jlRows.length > 0 && jlRows[0]!.journal_entry_id) {
      const { reverseJournalEntry } = await import('./journalEntryService');
      try {
        await reverseJournalEntry('', String(jlRows[0]!.journal_entry_id), userId);
      } catch (e) {
        throw new Error(`Cannot reverse: ${e instanceof Error ? e.message : 'Journal reversal failed'}`);
      }
    }
  }
  await sql`
    UPDATE bank_transactions
    SET status = 'imported', matched_journal_line_id = NULL, reconciliation_id = NULL,
        linked_po_id = NULL, linked_asset_id = NULL, linked_fleet_fuel_id = NULL,
        linked_fleet_service_id = NULL, allocation_type = NULL, allocated_entity_name = NULL,
        updated_at = NOW()
    WHERE id = ${bankTxId}::UUID`;
  log.info('Reversed reconciled bank transaction', { bankTxId, userId }, 'accounting');
}
