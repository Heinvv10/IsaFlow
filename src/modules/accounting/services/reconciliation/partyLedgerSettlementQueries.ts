/**
 * The party's credit notes, payments / receipts (contras and refunds are
 * payment rows with a method) and, for a customer, write-offs, each with the
 * journal chain it put on the control accounts.
 *
 * The table and column names come from the closed `SHAPE` literals below -- the
 * same pattern `unappliedCashService` uses -- never from input. Only values are
 * bound.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { journalChainLateral, parseJournalFacts } from './partyLedgerJournalLateral';
import type { PartyQueryArgs } from './partyLedgerInvoiceQuery';
import type { JournalFacts } from './partyLedgerTypes';

export interface RawSettlement {
  id: string;
  number: string | null;
  date: string;
  status: string | null;
  total: number;
  /** credit_notes.applied_amount; null for payments and write-offs. */
  applied: number | null;
  allocated: number;
  method: string | null;
  journal: JournalFacts;
}

const SHAPE = {
  ar: {
    payments: 'customer_payments', paymentParty: 'd.client_id', paymentAlloc: 'customer_payment_allocations',
    noteParty: 'd.client_id', noteLink: 'd.customer_invoice_id', noteType: 'customer',
  },
  ap: {
    payments: 'supplier_payments', paymentParty: 'd.supplier_id', paymentAlloc: 'payment_allocations',
    noteParty: 'd.supplier_id', noteLink: 'd.supplier_invoice_id', noteType: 'supplier',
  },
} as const;

function toSettlement(r: DbRow): RawSettlement {
  return {
    id: String(r.id),
    number: r.number == null ? null : String(r.number),
    date: fmtDate(r.doc_date as string | Date),
    status: r.status == null ? null : String(r.status),
    total: Number(r.total ?? 0),
    applied: r.applied == null ? null : Number(r.applied),
    allocated: Number(r.allocated ?? 0),
    method: r.method == null ? null : String(r.method),
    journal: parseJournalFacts(r, r.journal_id),
  };
}

export async function readPartyCreditNotes(side: 'ar' | 'ap', a: PartyQueryArgs): Promise<RawSettlement[]> {
  const { companyId, partyId, asAtDate, controlIds } = a;
  const shape = SHAPE[side];
  const rows = (await sql`
    SELECT d.id, d.credit_note_number AS number, d.credit_date AS doc_date, d.status,
           d.total_amount AS total, d.applied_amount AS applied, d.gl_journal_entry_id AS journal_id,
           CASE WHEN EXISTS (SELECT 1 FROM credit_note_allocations x
                             WHERE x.credit_note_id = d.id AND x.company_id = ${companyId}::UUID)
                THEN (SELECT SUM(x.amount_allocated) FROM credit_note_allocations x
                      WHERE x.credit_note_id = d.id AND x.company_id = ${companyId}::UUID)
                WHEN ${sql.unsafe(shape.noteLink)} IS NOT NULL THEN d.applied_amount
                ELSE 0 END AS allocated,
           jr.head_status, jr.head_date, jr.ctrl_net, jr.ctrl_lines, jr.reversals, jr.non_control
    FROM credit_notes d
    LEFT JOIN LATERAL (
      ${journalChainLateral({ companyId, asAtDate, controlIds, side, link: 'd.gl_journal_entry_id' })}
    ) jr ON TRUE
    WHERE d.company_id = ${companyId}::UUID
      AND d.type = ${shape.noteType}
      AND ${sql.unsafe(shape.noteParty)} = ${partyId}::UUID
      AND d.credit_date <= ${asAtDate}::DATE
    ORDER BY d.credit_date, d.id`) as DbRow[];
  return rows.map(toSettlement);
}

export async function readPartyPayments(side: 'ar' | 'ap', a: PartyQueryArgs): Promise<RawSettlement[]> {
  const { companyId, partyId, asAtDate, controlIds } = a;
  const shape = SHAPE[side];
  const rows = (await sql`
    SELECT d.id, d.payment_number AS number, d.payment_date AS doc_date, d.status,
           d.total_amount AS total, d.payment_method AS method, d.gl_journal_entry_id AS journal_id,
           COALESCE((SELECT SUM(x.amount_allocated) FROM ${sql.unsafe(shape.paymentAlloc)} x
                     WHERE x.payment_id = d.id), 0) AS allocated,
           jr.head_status, jr.head_date, jr.ctrl_net, jr.ctrl_lines, jr.reversals, jr.non_control
    FROM ${sql.unsafe(shape.payments)} d
    LEFT JOIN LATERAL (
      ${journalChainLateral({ companyId, asAtDate, controlIds, side, link: 'd.gl_journal_entry_id' })}
    ) jr ON TRUE
    WHERE d.company_id = ${companyId}::UUID
      AND ${sql.unsafe(shape.paymentParty)} = ${partyId}::UUID
      AND d.payment_date <= ${asAtDate}::DATE
    ORDER BY d.payment_date, d.id`) as DbRow[];
  return rows.map(toSettlement);
}

/** Customer write-offs only: there is no supplier equivalent in this schema. */
export async function readPartyWriteOffs(a: PartyQueryArgs): Promise<RawSettlement[]> {
  const { companyId, partyId, asAtDate, controlIds } = a;
  const rows = (await sql`
    SELECT d.id, d.write_off_number AS number, d.write_off_date AS doc_date, d.status,
           d.amount AS total, d.gl_journal_entry_id AS journal_id,
           jr.head_status, jr.head_date, jr.ctrl_net, jr.ctrl_lines, jr.reversals, jr.non_control
    FROM customer_write_offs d
    LEFT JOIN LATERAL (
      ${journalChainLateral({ companyId, asAtDate, controlIds, side: 'ar', link: 'd.gl_journal_entry_id' })}
    ) jr ON TRUE
    WHERE d.company_id = ${companyId}::UUID
      AND d.client_id = ${partyId}::UUID
      AND d.write_off_date <= ${asAtDate}::DATE
    ORDER BY d.write_off_date, d.id`) as DbRow[];
  return rows.map(toSettlement);
}
