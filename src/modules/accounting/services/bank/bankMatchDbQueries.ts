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
): Promise<{
  id: string; bankAccountId: string; amount: number; transactionDate: string; description: string; reference: string;
} | null> {
  const txRows = (await sql`
    SELECT id, bank_account_id, amount, transaction_date, description, reference
    FROM bank_transactions
    WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
  `) as DbRow[];
  if (txRows.length === 0) return null;
  const tx = txRows[0]!;
  return {
    id: String(tx.id),
    bankAccountId: String(tx.bank_account_id),
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
      AND si.deleted_at IS NULL
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
      AND ci.deleted_at IS NULL
      AND ci.company_id = ${companyId}
    ORDER BY ABS(ci.total_amount - COALESCE(ci.amount_paid, 0) - ${absAmount}::NUMERIC) ASC
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
  // purchase_orders_status_check allows draft/submitted/approved/
  // partially_received/received/cancelled. 'partially_paid' was a dead literal
  // no row can carry, and 'partially_received' — the status a part-delivered PO
  // actually holds — was never offered as a candidate.
  const allRows = (await sql`
    SELECT po.id, po.po_number, COALESCE(s.company_name, s.name) AS supplier_name,
           po.total, po.created_at
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.status IN ('approved', 'partially_received')
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
  bankAccountId?: string,
): Promise<MatchCandidate[]> {
  const jlRows = (await sql`
    SELECT jl.id, jl.description, jl.debit, jl.credit, je.entry_date, je.source,
      (je.reversed_at IS NOT NULL OR (je.reversal_of_id IS NOT NULL
        AND (orig.reversal_of_id IS NULL OR orig2.reversal_of_id IS NOT NULL))) AS undone,
      (jl.gl_account_id = ${bankAccountId ?? null}::UUID) IS TRUE AS own_bank
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    LEFT JOIN gl_journal_entries orig ON orig.id = je.reversal_of_id AND orig.company_id = je.company_id
    -- Three or more steps down the chain is never read as the live movement (an odd step is a reversal; fails closed).
    LEFT JOIN gl_journal_entries orig2 ON orig2.id = orig.reversal_of_id AND orig2.company_id = je.company_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}
      AND jl.company_id = ${companyId}::UUID
      -- Only a line that can be this statement line's bank leg: on its own bank, in its direction (money in debits
      -- the bank, money out credits it — brk-nrfa round 21).
      AND (${bankAccountId ?? null}::UUID IS NULL OR jl.gl_account_id = ${bankAccountId ?? null}::UUID)
      AND SIGN(jl.debit - jl.credit) = SIGN(${txAmount}::NUMERIC)
      AND jl.id NOT IN (
        SELECT matched_journal_line_id FROM bank_transactions
        WHERE matched_journal_line_id IS NOT NULL AND company_id = ${companyId}
      )
      -- A bank-first provisional's journal is held by its own line through provisional_je_id (confirm answers 409) —
      -- read through the reversal chain, as confirm does: a re-reversed provisional's live head is held too (sec-nrfa
      -- round 23, brk-nrfa round 24). Bounded and company-scoped like every walk here. The held set is computed ONCE,
      -- walking DOWN from every held provisional (a journal is held iff its chain reaches one), and hashed for NOT IN:
      -- a walk correlated to each candidate re-ran per bank line (6 s at 200k lines, sec-nrfa round 24 M1) or per
      -- leg x journal under a low estimate (139 s for a new tenant, brk-nrfa round 25 M1). DISTINCT keeps the NOT IN
      -- hashed whatever the held set's estimate (a plain SELECT spilled past hash_mem to a linear scan per candidate:
      -- 16-40 s with thousands of held provisionals, sec-nrfa round 26 M1).
      AND je.id NOT IN (
          WITH RECURSIVE held AS (
            SELECT bp.provisional_je_id AS id, 0 AS d FROM bank_transactions bp
            WHERE bp.provisional_je_id IS NOT NULL AND bp.company_id = ${companyId}::UUID
            UNION ALL SELECT c.id, held.d + 1 FROM gl_journal_entries c JOIN held ON c.reversal_of_id = held.id
              WHERE c.company_id = ${companyId}::UUID AND held.d < 64)
          SELECT DISTINCT id FROM held)
    -- Ties on the amount: a line on the statement line's own bank first (a transfer or payment journal's bank leg —
    -- what the transfer guard's match remedy needs, however old: brk-nrfa rounds 16-17), then the nearest date
    -- (computed only between finite dates: an 'infinity' date sorts last instead of failing the query — sec r16).
    ORDER BY ABS((jl.debit - jl.credit) - ${txAmount}::NUMERIC) ASC,
      (jl.gl_account_id = ${bankAccountId ?? null}::UUID) IS TRUE DESC,
      CASE WHEN isfinite(je.entry_date) AND isfinite(${txDate}::DATE) THEN ABS(je.entry_date - ${txDate}::DATE) END
        ASC NULLS LAST
    LIMIT 20
  `) as DbRow[];

  return jlRows.map((row) => {
    const lineNet = Number(row.debit) - Number(row.credit);
    const label = String(row.description ?? 'Journal line');
    const candDate = fmtDate(row.entry_date);
    // A reversed transfer, or the reversal undoing one, is not a movement the statement line can be the other leg of.
    // Only the leg on the statement line's own bank: the other bank's leg is that bank's movement, not this line's.
    const isTransfer = String(row.source || '') === 'auto_bank_transfer' && row.undone !== true && row.own_bank === true;
    let score = scoreAmount(txAmount, lineNet) + scoreDate(txDate, candDate) + scoreDescription(txDesc, label);
    let matchReason: string | undefined = Math.abs(lineNet - txAmount) < 0.01 ? 'Exact amount match' : undefined;
    // Only a transfer journal of the same movement (the transfer guard's ten days) is "the existing transfer": an old
    // unmatched leg of the amount on this bank is an ordinary candidate, not the top one.
    const gapDays = Math.abs(new Date(txDate).getTime() - new Date(candDate).getTime()) / 86400000;
    const sameMovement = gapDays <= 10;
    if (isTransfer && !sameMovement && gapDays <= 30 && Math.abs(lineNet - txAmount) < 0.01) {
      // Past the guard's ten days nothing refuses a second posting, so a late-clearing leg is still named, lower.
      score += 20;
      matchReason = `May be an existing bank transfer journal (${Math.round(gapDays)} days apart) — check it before posting a new transfer`;
    }
    if (isTransfer && sameMovement && Math.abs(lineNet - txAmount) < 0.01) {
      // Surface the opposite leg of an inter-account transfer at the top — no
      // new JE must be posted, user should match against this existing one.
      score += 40;
      matchReason = 'Matches existing bank transfer journal — select to reconcile without posting a new entry';
    }
    return {
      type: isTransfer && gapDays <= 30 ? ('bank_transfer' as const) : ('journal_line' as const),
      id: String(row.id), label, amount: lineNet, date: candDate, score, matchReason,
    };
  });
}
