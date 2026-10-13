/**
 * The expense credit of a SUPPLIER credit note (migration 892) — the mirror of
 * a customer note's revenue debit (ar/invoiceRevenuePosting
 * `creditNoteRevenueJournalLines`), sharing its pure allocator
 * (ar/invoiceRevenueLines `allocateCreditNote`, side 'credit').
 *
 * `approveCreditNote` makes ONE call here and keeps its AP debit (total) and
 * single VAT credit (tax) as they were. Before 892 it credited the whole net
 * to default_expense, whatever the bill had debited (Velocity Fibre re-pointed
 * R8.54m off 5100 by journal on 13 Oct 2026).
 *
 * Where the net goes, in order:
 *  1. LINKED to a bill that carries a journal: that journal's legs other than
 *     its AP and VAT ones — picked BY ROLE (the payable / VAT input accounts,
 *     any AP/AR control subtype, the VAT class), not by account type, because
 *     a bill may debit an asset or COS account — pro rata to each leg's net,
 *     on the leg's account, job, CC1, CC2 and BU. Each leg is capped at what it
 *     still carries: its net less what the live (approved, not cancelled)
 *     earlier notes on the bill took, as `credit_note_expense_allocations`
 *     records it; notes approved before 892 recorded nothing and are REPLAYED
 *     in approval order. A leg whose account was deactivated since is credited
 *     on the fallback account, keeping its tags.
 *  2. What no leg can take (no bill, a bill with no journal, a bill already
 *     fully credited): the note's own `gl_account_id`, else default_expense —
 *     untagged on a linked note; an unlinked note carries its header CC1 / CC2
 *     / BU there, as 870 posted them.
 *
 * Called with the bill's credit-note lock held
 * (ar/creditNotePostingChecks.lockInvoiceCreditNotes), so no other approval of
 * a note on this bill can run between these reads and this note's rows.
 */
import { sql } from '@/lib/neon';
import type { JournalLineInput } from '../../types/gl.types';
import { canonicalSubtype } from '../gl/accountSubtypes';
import { reportingClassFor } from '../gl/accountReportingClass';
import {
  allocateCreditNote, NO_TAGS, type CreditNoteAllocation, type LegTags, type RevenueLeg,
} from '../ar/invoiceRevenueLines';
import { CreditNoteDimensionRefusal } from '../ar/creditNoteHeaderTags';
import { assertBillLineAccounts } from './billLineAccountGuard';

export interface SupplierCreditNotePosting {
  id: string;
  number: string;
  /** The note's net (subtotal). */
  amount: number;
  supplierInvoiceId: string | null;
  /** The note's own account (892), or null. */
  glAccountId: string | null;
  /** Header CC1 / CC2 / BU — posted on an unlinked note only. */
  tags: LegTags;
}

export interface BillJournalLegRow {
  journal_line_id: string;
  gl_account_id: string;
  is_active: boolean;
  account_subtype: string | null;
  project_id: string | null;
  cc1_id: string | null;
  cc2_id: string | null;
  bu_id: string | null;
  /** Debit minus credit. */
  net: number | string;
}

/** The bill journal's AP and VAT legs, by role. Everything else is what the bill expensed. */
export function isBillExpenseLeg(row: Pick<BillJournalLegRow, 'gl_account_id' | 'account_subtype'>,
  roleAccountIds: ReadonlySet<string>): boolean {
  if (roleAccountIds.has(String(row.gl_account_id).toLowerCase())) return false;
  const canonical = canonicalSubtype(row.account_subtype);
  if (canonical === 'payable' || canonical === 'receivable') return false;
  return reportingClassFor(row.account_subtype) !== 'vat';
}

const id = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** Pure: the bill's legs as the allocator reads them. */
export function billExpenseLegs(
  rows: readonly BillJournalLegRow[],
  roleAccountIds: ReadonlySet<string>,
  takenByLine: ReadonlyMap<string, number>,
  fallbackAccountId: string,
): RevenueLeg[] {
  return rows.filter((r) => isBillExpenseLeg(r, roleAccountIds)).map((r) => ({
    glAccountId: String(r.gl_account_id),
    postAccountId: r.is_active === true ? String(r.gl_account_id) : fallbackAccountId,
    projectId: id(r.project_id), cc1Id: id(r.cc1_id), cc2Id: id(r.cc2_id), buId: id(r.bu_id),
    net: Number(r.net),
    taken: takenByLine.get(String(r.journal_line_id)) ?? 0,
    journalLineId: String(r.journal_line_id),
  }));
}

export async function creditNoteExpenseJournalLines(
  companyId: string,
  note: SupplierCreditNotePosting,
  accounts: { defaultExpenseAccountId: string; payableAccountId: string; vatInputAccountId: string | null },
): Promise<{ lines: JournalLineInput[]; allocations: CreditNoteAllocation[] }> {
  // The note's own account is re-checked against the chart as it is NOW (it may have been
  // deactivated, reclassified or merged away since create): refused, never silently swapped.
  if (note.glAccountId) await assertBillLineAccounts(companyId, [note.glAccountId]);
  const fallback = note.glAccountId ?? accounts.defaultExpenseAccountId;
  if (!note.supplierInvoiceId) {
    const { lines } = allocateCreditNote(
      [{ glAccountId: fallback, ...note.tags, net: note.amount }], note.amount, note.number, fallback, [], 'credit',
    );
    return { lines, allocations: [] };
  }
  const billLegs = (await sql`
    SELECT jl.id AS journal_line_id, jl.gl_account_id, a.is_active, a.account_subtype,
           jl.project_id, jl.cc1_id, jl.cc2_id, jl.bu_id, jl.debit - jl.credit AS net
    FROM supplier_invoices si
    JOIN gl_journal_lines jl
      ON jl.journal_entry_id = si.gl_journal_entry_id AND jl.company_id = si.company_id
    JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE si.id = ${note.supplierInvoiceId}::UUID AND si.company_id = ${companyId}::UUID
    ORDER BY jl.created_at, jl.id
  `) as BillJournalLegRow[];
  // What the live earlier notes took, per bill journal line.
  const taken = (await sql`
    SELECT a.journal_line_id, SUM(a.amount) AS amount
    FROM credit_note_expense_allocations a
    JOIN credit_notes cn ON cn.id = a.credit_note_id AND cn.company_id = a.company_id
    WHERE a.company_id = ${companyId}::UUID AND a.bill_id = ${note.supplierInvoiceId}::UUID
      AND NOT a.is_excess AND cn.status NOT IN ('draft', 'cancelled') AND cn.id <> ${note.id}::UUID
    GROUP BY a.journal_line_id
  `) as { journal_line_id: string; amount: number | string }[];
  // Live earlier notes on this bill that recorded nothing: approved before 892 — replayed.
  const legacy = (await sql`
    SELECT cn.subtotal FROM credit_notes cn
    WHERE cn.company_id = ${companyId}::UUID AND cn.supplier_invoice_id = ${note.supplierInvoiceId}::UUID
      AND cn.type = 'supplier' AND cn.status NOT IN ('draft', 'cancelled') AND cn.id <> ${note.id}::UUID
      AND NOT EXISTS (SELECT 1 FROM credit_note_expense_allocations a
                      WHERE a.company_id = cn.company_id AND a.credit_note_id = cn.id)
    ORDER BY cn.approved_at NULLS FIRST, cn.id
  `) as { subtotal: number | string }[];

  const roles = new Set([accounts.payableAccountId, accounts.vatInputAccountId]
    .filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase()));
  const takenByLine = new Map(taken.map((r) => [String(r.journal_line_id), Number(r.amount)]));
  const legs = billExpenseLegs(billLegs, roles, takenByLine, fallback);
  const out = allocateCreditNote(legs, note.amount, note.number, fallback, legacy.map((e) => Number(e.subtotal)), 'credit');
  return { lines: out.lines, allocations: out.allocations };
}

/** What an approved note took per bill leg (and its excess), in the approval's transaction. */
export async function recordCreditNoteExpenseAllocations(
  companyId: string,
  creditNoteId: string,
  billId: string,
  allocations: readonly CreditNoteAllocation[],
): Promise<void> {
  for (const a of allocations) {
    await sql`
      INSERT INTO credit_note_expense_allocations
        (company_id, credit_note_id, bill_id, journal_line_id, gl_account_id, project_id, cc1_id, cc2_id, bu_id,
         amount, is_excess)
      VALUES (${companyId}::UUID, ${creditNoteId}::UUID, ${billId}::UUID, ${a.journalLineId}::UUID, ${a.glAccountId}::UUID,
              ${a.projectId}::UUID, ${a.cc1Id}::UUID, ${a.cc2Id}::UUID, ${a.buId}::UUID, ${a.amount}, ${a.isExcess})
    `;
  }
}

/**
 * A supplier note's header CC1 / CC2 / BU, checked at create and approve before any write: on a note
 * LINKED to a bill they could never post (the bill's legs decide, on all five tags), so they are
 * REFUSED, as creditNoteHeaderTags refuses them on a linked customer note.
 */
export function assertSupplierNoteHeaderTags(note: {
  supplierInvoiceId: string | null; cc1Id: string | null; cc2Id: string | null; buId: string | null;
}): LegTags {
  const tags: LegTags = { ...NO_TAGS, cc1Id: note.cc1Id, cc2Id: note.cc2Id, buId: note.buId };
  if (note.supplierInvoiceId && (note.cc1Id || note.cc2Id || note.buId)) {
    throw new CreditNoteDimensionRefusal(
      'A supplier credit note linked to a bill reverses the expense lines of that bill, so its CC1, CC2 and BU '
      + 'come from the bill and cannot be set on the note. Leave them empty (cancel this draft and raise it again '
      + 'without them), or raise the note without the bill link.',
    );
  }
  return note.supplierInvoiceId ? NO_TAGS : tags;
}
