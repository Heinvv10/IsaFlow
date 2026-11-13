/**
 * The reads behind `shareUndoPlan.ts` (void_payment undo_share, step 6). Every one names `company_id`; none writes or
 * locks — the plan runs inside the void, after the void has taken its locks (bank line → payment) and before its
 * first write, so what these read is what the void acts on.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { paymentSettlementKindSql } from './settlementKind';

export interface JournalHead {
  id: string;
  entryNumber: string | null;
  entryDate: string;
  status: string;
  reversed: boolean;
}

export interface JournalLineRow {
  glAccountId: string;
  accountCode: string | null;
  accountName: string | null;
  accountSubtype: string | null;
  debit: number;
  credit: number;
  vatType: string | null;
  projectId: string | null;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
}

export interface BillRow {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  journalEntryId: string | null;
}

const str = (v: unknown): string | null => (v == null ? null : String(v));
const money = (v: unknown): number => Math.round(Number(v ?? 0) * 100) / 100;

/** The payment's settlement kind (`settlementKind.ts`, the one rule) — null when it is not this company's. */
export async function readPaymentKind(companyId: string, paymentId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT ${paymentSettlementKindSql('sp')} AS kind FROM supplier_payments sp
    WHERE sp.id = ${paymentId}::UUID AND sp.company_id = ${companyId}::UUID`) as DbRow[];
  return rows[0] ? String(rows[0].kind) : null;
}

export async function readJournalHead(companyId: string, journalId: string): Promise<JournalHead | null> {
  const rows = (await sql`
    SELECT id, entry_number, entry_date, status, reversed_at FROM gl_journal_entries
    WHERE id = ${journalId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), entryNumber: str(r.entry_number), entryDate: fmtDate(r.entry_date as string | Date),
    status: String(r.status), reversed: r.reversed_at != null,
  };
}

/** A journal's lines with their accounts, in line-id order (a deterministic order; lines carry no ordinal). */
export async function readJournalLines(companyId: string, journalId: string): Promise<JournalLineRow[]> {
  const rows = (await sql`
    SELECT jl.gl_account_id, ga.account_code, ga.account_name, ga.account_subtype, jl.debit, jl.credit, jl.vat_type,
           jl.project_id, jl.cc1_id, jl.cc2_id, jl.bu_id
    FROM gl_journal_lines jl
    LEFT JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
    WHERE jl.journal_entry_id = ${journalId}::UUID AND jl.company_id = ${companyId}::UUID
    ORDER BY jl.id`) as DbRow[];
  return rows.map((r) => ({
    glAccountId: String(r.gl_account_id), accountCode: str(r.account_code), accountName: str(r.account_name),
    accountSubtype: str(r.account_subtype), debit: money(r.debit), credit: money(r.credit), vatType: str(r.vat_type),
    projectId: str(r.project_id), cc1Id: str(r.cc1_id), cc2Id: str(r.cc2_id), buId: str(r.bu_id),
  }));
}

/** Other live payment documents posted by the same journal (a split allocation writes several). */
export async function countSiblingPayments(companyId: string, journalId: string, paymentId: string): Promise<number> {
  const rows = (await sql`
    SELECT (SELECT COUNT(*) FROM supplier_payments
             WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${journalId}::UUID
               AND id <> ${paymentId}::UUID AND status <> 'cancelled')
         + (SELECT COUNT(*) FROM customer_payments
             WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${journalId}::UUID
               AND status <> 'cancelled') AS n`) as DbRow[];
  return Number(rows[0]?.n ?? 0);
}

/**
 * The payment's allocation rows, per bill. `payment_allocations` has no company_id: the caller has read the payment
 * back under company_id (the void's `loadPayment`), and the bills are read below under it again.
 */
export async function readPaymentAllocations(paymentId: string): Promise<{ billId: string; amount: number; rows: number }[]> {
  const rows = (await sql`
    SELECT invoice_id, SUM(amount_allocated) AS amount, COUNT(*)::INT AS n FROM payment_allocations
    WHERE payment_id = ${paymentId}::UUID AND amount_allocated > 0
    GROUP BY invoice_id ORDER BY invoice_id`) as DbRow[];
  return rows.map((r) => ({ billId: String(r.invoice_id), amount: money(r.amount), rows: Number(r.n) }));
}

export async function readBills(companyId: string, billIds: readonly string[]): Promise<Map<string, BillRow>> {
  const rows = (await sql`
    SELECT id, invoice_number, total_amount, gl_journal_entry_id FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID AND id = ANY(${[...billIds]}::UUID[])`) as DbRow[];
  return new Map(rows.map((r) => [String(r.id), {
    id: String(r.id), invoiceNumber: String(r.invoice_number), totalAmount: money(r.total_amount),
    journalEntryId: str(r.gl_journal_entry_id),
  }]));
}

/** An account's code, for a refusal that names an account the share journal does not carry. */
export async function readAccountCode(companyId: string, accountId: string): Promise<string> {
  const rows = (await sql`
    SELECT account_code FROM gl_accounts WHERE id = ${accountId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  return rows[0]?.account_code == null ? accountId : String(rows[0].account_code);
}

/** Live (draft or posted, not reversed) journals already carrying one of these undo references. */
export async function findPriorUndos(companyId: string, references: readonly string[]): Promise<Map<string, string>> {
  const rows = (await sql`
    SELECT reference, entry_number FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID AND reference = ANY(${[...references]}::TEXT[])
      AND status IN ('draft', 'posted') AND reversed_at IS NULL
    ORDER BY reference, entry_number`) as DbRow[];
  return new Map(rows.map((r) => [String(r.reference), String(r.entry_number ?? '(unnumbered)')]));
}
