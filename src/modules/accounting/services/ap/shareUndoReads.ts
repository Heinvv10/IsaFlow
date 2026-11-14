/**
 * The reads behind `shareUndoPlan.ts` (void_payment undo_share, step 6). Every one names `company_id`; none writes.
 * The plan runs inside the void, after the void has taken its locks (bank line → payment) and before its first
 * write, so what these read is what the void acts on. One of them locks: `lockShareJournal`, taken after the payment
 * lock (the order every undo takes them in).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { paymentSettlementKindSql } from './settlementKind';
import { readHandUndoConsumption } from './shareUndoHandUndos';

export interface JournalHead {
  id: string;
  entryNumber: string | null;
  entryDate: string;
  status: string;
  reversed: boolean;
  /** Set on an s16(3) late-claim companion. */
  lateClaimOfId: string | null;
  source: string | null;
}

export interface JournalLineRow {
  glAccountId: string;
  accountCode: string | null;
  accountName: string | null;
  accountSubtype: string | null;
  accountActive: boolean;
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
  invoiceDate: string;
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
    SELECT id, entry_number, entry_date, status, reversed_at, late_claim_of_id, source FROM gl_journal_entries
    WHERE id = ${journalId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), entryNumber: str(r.entry_number), entryDate: fmtDate(r.entry_date as string | Date),
    status: String(r.status), reversed: r.reversed_at != null, lateClaimOfId: str(r.late_claim_of_id), source: str(r.source),
  };
}

/** A journal's lines with their accounts, in line-id order (a deterministic order; lines carry no ordinal). */
export async function readJournalLines(companyId: string, journalId: string): Promise<JournalLineRow[]> {
  const rows = (await sql`
    SELECT jl.gl_account_id, ga.account_code, ga.account_name, ga.account_subtype, ga.is_active, jl.debit, jl.credit, jl.vat_type,
           jl.project_id, jl.cc1_id, jl.cc2_id, jl.bu_id
    FROM gl_journal_lines jl
    LEFT JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
    WHERE jl.journal_entry_id = ${journalId}::UUID AND jl.company_id = ${companyId}::UUID
    ORDER BY jl.id`) as DbRow[];
  return rows.map((r) => ({
    glAccountId: String(r.gl_account_id), accountCode: str(r.account_code), accountName: str(r.account_name),
    accountSubtype: str(r.account_subtype), accountActive: r.is_active !== false, debit: money(r.debit), credit: money(r.credit), vatType: str(r.vat_type),
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
    SELECT id, invoice_number, total_amount, invoice_date, gl_journal_entry_id FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID AND id = ANY(${[...billIds]}::UUID[])`) as DbRow[];
  return new Map(rows.map((r) => [String(r.id), {
    id: String(r.id), invoiceNumber: String(r.invoice_number), totalAmount: money(r.total_amount),
    invoiceDate: fmtDate(r.invoice_date as string | Date), journalEntryId: str(r.gl_journal_entry_id),
  }]));
}

/** An account's code, for a refusal that names an account the share journal does not carry. */
export async function readAccountCode(companyId: string, accountId: string): Promise<string> {
  const rows = (await sql`
    SELECT account_code FROM gl_accounts WHERE id = ${accountId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  return rows[0]?.account_code == null ? accountId : String(rows[0].account_code);
}

/**
 * A live (draft or posted, not reversed) earlier undo of each bill, keyed by bill id: one carrying this payment's
 * exact reference, or any undo LINKED to this share (`source_record_id`) whose reference names the bill
 * (`undo-share:<any payment>:<bill>`) — round 5: the link, not the reference text, says what is an undo of the share.
 */
export async function findPriorUndos(
  companyId: string, shareJournalId: string, journals: readonly { billId: string; reference: string }[],
): Promise<Map<string, string>> {
  const rows = (await sql`
    SELECT b.bill_id, je.entry_number
    FROM UNNEST(${journals.map((j) => j.billId)}::TEXT[], ${journals.map((j) => j.reference)}::TEXT[]) AS b(bill_id, ref)
    JOIN gl_journal_entries je ON je.company_id = ${companyId}::UUID
      AND je.status IN ('draft', 'posted') AND je.reversed_at IS NULL
      AND (je.reference = b.ref
           OR (je.source_record_id = ${shareJournalId}::UUID AND je.reference LIKE 'undo-share:%:' || b.bill_id))
    ORDER BY b.bill_id, je.entry_number`) as DbRow[];
  return new Map(rows.map((r) => [String(r.bill_id), String(r.entry_number ?? '(unnumbered)')]));
}

/**
 * Lock the share journal's head for the rest of the request, after the payment lock. FOR UPDATE, not FOR SHARE: two
 * undos against one share (different payments, so different payment locks) would both hold a SHARE lock and both
 * read the same consumption, then both post; the row lock serialises them, and a reversal of the share (which locks
 * the head FOR UPDATE) waits for the undo or the undo waits for it — either way the second reads the first's result.
 */
export async function lockShareJournal(companyId: string, journalId: string): Promise<void> {
  await sql`SELECT id FROM gl_journal_entries
    WHERE id = ${journalId}::UUID AND company_id = ${companyId}::UUID FOR UPDATE`;
}

export interface ShareConsumption {
  /**
   * Per account, in cents: `credit` is what came back on the clearing account X (net), `debit` what came back on each
   * of the share's accounts (net). Linked undos and hand undos together.
   */
  byAccount: Map<string, { debit: number; credit: number }>;
  /** Entry numbers of the hand undos counted (for the refusal). */
  handUndos: string[];
}

/**
 * What has already come back out of this share, per account, in cents: the LINKED undos (`source_record_id` = the
 * share, live, whatever their reference — what void_payment writes) plus every HAND undo in its window
 * (`shareUndoHandUndos.readHandUndoConsumption`, which says how).
 */
export async function readShareConsumption(
  companyId: string, shareJournalId: string, clearingId: string, billDates: readonly string[],
): Promise<ShareConsumption> {
  const rows = (await sql`
    SELECT jl.gl_account_id, SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = ${companyId}::UUID
    WHERE jl.company_id = ${companyId}::UUID AND je.source_record_id = ${shareJournalId}::UUID
      AND je.status IN ('draft', 'posted') AND je.reversed_at IS NULL
    GROUP BY jl.gl_account_id`) as DbRow[];
  const byAccount = new Map<string, { debit: number; credit: number }>();
  for (const r of rows) {
    byAccount.set(String(r.gl_account_id), {
      debit: Math.round(Number(r.debit ?? 0) * 100), credit: Math.round(Number(r.credit ?? 0) * 100),
    });
  }
  const hand = await readHandUndoConsumption(companyId, shareJournalId, clearingId, billDates);
  for (const [account, net] of hand.byAccount) {
    const cur = byAccount.get(account) ?? { debit: 0, credit: 0 };
    byAccount.set(account, { debit: cur.debit + net.debit, credit: cur.credit + net.credit });
  }
  return { byAccount, handUndos: hand.handUndos };
}

/** Has this bill journal been split by the s16(3) late claim (a companion names it)? */
export async function hasLateClaimCompanion(companyId: string, journalId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID AND late_claim_of_id = ${journalId}::UUID LIMIT 1`) as DbRow[];
  return rows.length > 0;
}
