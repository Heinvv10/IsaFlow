/**
 * Bank Match DB Queries
 * Fetches supplier/customer invoices, purchase orders, and journal lines
 * as match candidates for a given bank transaction.
 */

import { sql } from '@/lib/neon';
import type { MatchCandidate } from '@/modules/accounting/types/bank-match.types';
import type { DbRow } from '@/types/db';
import {
  scoreAmount,
  scoreDate,
  scoreDescription,
  fmtDate,
  entityNameMatches,
  invoiceRefMatches,
  findInvoiceCombos,
  type InvoiceRow,
} from './bankMatchCandidatesService';


export async function fetchBankTransaction(
  bankTransactionId: string,
  companyId: string,
): Promise<{ id: string; amount: number; transactionDate: string; description: string; reference: string } | null> {
  const txRows = (await sql`
    SELECT id, amount, transaction_date, description, reference
    FROM bank_transactions
    WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
  `) as DbRow[];
  if (txRows.length === 0) return null;
  const tx = txRows[0]!;
  return {
    id: String(tx.id),
    amount: Number(tx.amount),
    transactionDate: fmtDate(tx.transaction_date),
    description: String(tx.description ?? tx.reference ?? ''),
    reference: String(tx.reference ?? ''),
  };
}

export async function fetchSupplierInvoiceCandidates(
  companyId: string,
  absAmount: number,
  txAmount: number,
  txDate: string,
  txDesc: string,
  extractedEntity: string,
  invoiceRefs: string[],
): Promise<MatchCandidate[]> {
  const allRows = (await sql`
    SELECT si.id, si.invoice_number, COALESCE(s.company_name, s.name) AS supplier_name,
           si.total_amount, si.invoice_date, si.amount_paid
    FROM supplier_invoices si
    JOIN suppliers s ON s.id = si.supplier_id
    WHERE si.status IN ('approved', 'partially_paid')
      AND si.company_id = ${companyId}
    ORDER BY ABS(si.total_amount - COALESCE(si.amount_paid, 0) - ${absAmount}::NUMERIC) ASC
    LIMIT 50
  `) as DbRow[];

  let rows = allRows;
  if (extractedEntity) {
    const filtered = allRows.filter((r: DbRow) => entityNameMatches(String(r.supplier_name), extractedEntity));
    if (filtered.length > 0) rows = filtered;
  }

  const candidates: MatchCandidate[] = [];
  const comboPool: InvoiceRow[] = [];

  for (const row of rows.slice(0, 20)) {
    const invNum = String(row.invoice_number);
    const label = `${String(row.supplier_name)} — Inv ${invNum}`;
    // What is still OWED, not the gross — `status IN (…'partially_paid')` above
    // deliberately admits part-paid bills, and a payment settles the remainder.
    // The customer arm below has always done this; the supplier arm had not, so
    // a R300 settlement of a R1,000 bill already R700 paid was offered at
    // R1,000 and an unrelated R1,000 bill outranked it.
    const balance = Number(row.total_amount) - Number(row.amount_paid || 0);
    const candDate = fmtDate(row.invoice_date);

    let score = scoreAmount(txAmount, balance) + scoreDate(txDate, candDate) + scoreDescription(txDesc, label);
    let matchReason: string | undefined;

    if (invoiceRefMatches(invNum, invoiceRefs)) { score += 30; matchReason = `Reference ${invNum} found in description`; }
    if (Math.abs(balance - absAmount) < 0.01) { matchReason = matchReason ? `${matchReason} + exact amount` : 'Exact amount match'; }

    candidates.push({ type: 'supplier_invoice', id: String(row.id), label, amount: balance, date: candDate, score, matchReason });
    comboPool.push({ id: String(row.id), invoiceNumber: invNum, entityName: String(row.supplier_name), balance, date: candDate, type: 'supplier_invoice' });
  }

  for (const combo of findInvoiceCombos(comboPool, absAmount)) {
    const label = `${combo[0]!.entityName} — ${combo.length} invoices (${combo.map(c => c.invoiceNumber).join(' + ')})`;
    candidates.push({ type: 'supplier_invoice', id: combo.map(c => c.id).join(','), label, amount: combo.reduce((s, c) => s + c.balance, 0), date: combo[0]!.date, score: 95, matchReason: `${combo.length} invoices sum to exact payment amount` });
  }

  return candidates;
}

export async function fetchCustomerInvoiceCandidates(
  companyId: string,
  absAmount: number,
  txAmount: number,
  txDate: string,
  txDesc: string,
  extractedEntity: string,
  invoiceRefs: string[],
): Promise<MatchCandidate[]> {
  const allRows = (await sql`
    SELECT ci.id, ci.invoice_number, c.name AS customer_name,
           ci.total_amount, ci.invoice_date, ci.amount_paid
    FROM customer_invoices ci
    JOIN customers c ON c.id = ci.customer_id
    WHERE ci.status IN ('approved', 'sent', 'partially_paid', 'overdue')
      AND ci.company_id = ${companyId}
    ORDER BY ABS(ci.total_amount - ci.amount_paid - ${absAmount}::NUMERIC) ASC
    LIMIT 50
  `) as DbRow[];

  let rows = allRows;
  if (extractedEntity) {
    const filtered = allRows.filter((r: DbRow) => entityNameMatches(String(r.customer_name), extractedEntity));
    if (filtered.length > 0) rows = filtered;
  }

  const candidates: MatchCandidate[] = [];
  const comboPool: InvoiceRow[] = [];

  for (const row of rows.slice(0, 20)) {
    const invNum = String(row.invoice_number);
    const label = `${String(row.customer_name)} — Inv ${invNum}`;
    const balance = Number(row.total_amount) - Number(row.amount_paid || 0);
    const candDate = fmtDate(row.invoice_date);

    let score = scoreAmount(txAmount, balance) + scoreDate(txDate, candDate) + scoreDescription(txDesc, label);
    let matchReason: string | undefined;

    if (invoiceRefMatches(invNum, invoiceRefs)) { score += 30; matchReason = `Reference ${invNum} found in description`; }
    if (Math.abs(balance - absAmount) < 0.01) { matchReason = matchReason ? `${matchReason} + exact amount` : 'Exact amount match'; }

    candidates.push({ type: 'customer_invoice', id: String(row.id), label, amount: balance, date: candDate, score, matchReason });
    comboPool.push({ id: String(row.id), invoiceNumber: invNum, entityName: String(row.customer_name), balance, date: candDate, type: 'customer_invoice' });
  }

  for (const combo of findInvoiceCombos(comboPool, absAmount)) {
    const label = `${combo[0]!.entityName} — ${combo.length} invoices (${combo.map(c => c.invoiceNumber).join(' + ')})`;
    candidates.push({ type: 'customer_invoice', id: combo.map(c => c.id).join(','), label, amount: combo.reduce((s, c) => s + c.balance, 0), date: combo[0]!.date, score: 95, matchReason: `${combo.length} invoices sum to exact receipt amount` });
  }

  return candidates;
}

export async function fetchPurchaseOrderCandidates(
  companyId: string,
  absAmount: number,
  txAmount: number,
  txDate: string,
  txDesc: string,
  extractedEntity: string,
  invoiceRefs: string[],
): Promise<MatchCandidate[]> {
  const allRows = (await sql`
    SELECT po.id, po.po_number, COALESCE(s.company_name, s.name) AS supplier_name,
           po.total, po.created_at
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.status IN ('approved', 'partially_paid')
      AND po.company_id = ${companyId}
    ORDER BY ABS(po.total - ${absAmount}::NUMERIC) ASC
    LIMIT 50
  `) as DbRow[];

  let rows = allRows;
  if (extractedEntity) {
    const filtered = allRows.filter((r: DbRow) => entityNameMatches(String(r.supplier_name), extractedEntity));
    if (filtered.length > 0) rows = filtered;
  }

  return rows.slice(0, 20).map((row) => {
    const poNum = String(row.po_number);
    const label = `${String(row.supplier_name)} — PO ${poNum}`;
    const candAmount = Number(row.total);
    const candDate = fmtDate(row.created_at);

    let score = scoreAmount(txAmount, candAmount) + scoreDate(txDate, candDate) + scoreDescription(txDesc, label);
    let matchReason: string | undefined;

    if (invoiceRefMatches(poNum, invoiceRefs)) { score += 30; matchReason = `Reference ${poNum} found in description`; }
    if (Math.abs(candAmount - absAmount) < 0.01) { matchReason = matchReason ? `${matchReason} + exact amount` : 'Exact amount match'; }

    return { type: 'purchase_order' as const, id: String(row.id), label, amount: candAmount, date: candDate, score, matchReason };
  });
}

export async function fetchJournalLineCandidates(
  companyId: string,
  txAmount: number,
  txDate: string,
  txDesc: string,
): Promise<MatchCandidate[]> {
  const jlRows = (await sql`
    SELECT jl.id, jl.description, jl.debit, jl.credit, je.entry_date, je.source
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}
      AND jl.company_id = ${companyId}::UUID
      AND jl.id NOT IN (
        SELECT matched_journal_line_id FROM bank_transactions
        WHERE matched_journal_line_id IS NOT NULL AND company_id = ${companyId}
      )
    ORDER BY ABS((jl.debit - jl.credit) - ${txAmount}::NUMERIC) ASC
    LIMIT 20
  `) as DbRow[];

  return jlRows.map((row) => {
    const lineNet = Number(row.debit) - Number(row.credit);
    const label = String(row.description ?? 'Journal line');
    const candDate = fmtDate(row.entry_date);
    const isTransfer = String(row.source || '') === 'auto_bank_transfer';
    let score = scoreAmount(txAmount, lineNet) + scoreDate(txDate, candDate) + scoreDescription(txDesc, label);
    let matchReason: string | undefined = Math.abs(lineNet - txAmount) < 0.01 ? 'Exact amount match' : undefined;
    if (isTransfer && Math.abs(lineNet - txAmount) < 0.01) {
      // Surface the opposite leg of an inter-account transfer at the top — no
      // new JE must be posted, user should match against this existing one.
      score += 40;
      matchReason = 'Matches existing bank transfer journal — select to reconcile without posting a new entry';
    }
    return {
      type: isTransfer ? ('bank_transfer' as const) : ('journal_line' as const),
      id: String(row.id), label, amount: lineNet, date: candDate, score, matchReason,
    };
  });
}
