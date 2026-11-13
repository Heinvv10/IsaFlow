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
import { documentInPopulationExpr } from '../shared/documentPopulation';
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
  /** Allocation rows counted at as_at: the target document must be in the subledger by then too. */
  allocated: number;
  /** Credit notes: every allocation row, undated -- what `applied_amount` is tested against. */
  trailAllocated: number;
  method: string | null;
  journal: JournalFacts;
}

const SHAPE = {
  ar: {
    invoices: 'customer_invoices ci', invoiceAlias: 'ci' as const, invoiceDate: 'COALESCE(ci.invoice_date, ci.created_at::date)',
    payments: 'customer_payments', paymentParty: 'd.client_id', paymentAlloc: 'customer_payment_allocations',
    noteParty: 'd.client_id', noteLink: 'd.customer_invoice_id', noteType: 'customer',
  },
  ap: {
    invoices: 'supplier_invoices si', invoiceAlias: 'si' as const, invoiceDate: 'COALESCE(si.invoice_date, si.created_at::date)',
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
    trailAllocated: Number(r.trail_allocated ?? r.allocated ?? 0),
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
           -- At as_at: an allocation counts only once the invoice it settles is in the
           -- subledger (the credit note itself is dated on or before as_at by the WHERE).
           CASE WHEN EXISTS (SELECT 1 FROM credit_note_allocations x
                             WHERE x.credit_note_id = d.id AND x.company_id = ${companyId}::UUID)
                THEN COALESCE((SELECT SUM(x.amount_allocated) FROM credit_note_allocations x
                      JOIN ${sql.unsafe(shape.invoices)} ON ${sql.unsafe(shape.invoiceAlias)}.id = x.invoice_id
                           AND ${sql.unsafe(shape.invoiceAlias)}.company_id = ${companyId}::UUID
                      WHERE x.credit_note_id = d.id AND x.company_id = ${companyId}::UUID
                        AND ${sql.unsafe(shape.invoiceDate)} <= ${asAtDate}::DATE
                        AND ${sql.unsafe(documentInPopulationExpr(shape.invoiceAlias))}), 0)
                WHEN ${sql.unsafe(shape.noteLink)} IS NOT NULL AND EXISTS (
                       SELECT 1 FROM ${sql.unsafe(shape.invoices)}
                       WHERE ${sql.unsafe(shape.invoiceAlias)}.id = ${sql.unsafe(shape.noteLink)}
                         AND ${sql.unsafe(shape.invoiceAlias)}.company_id = ${companyId}::UUID
                         AND ${sql.unsafe(shape.invoiceDate)} <= ${asAtDate}::DATE)
                THEN d.applied_amount
                ELSE 0 END AS allocated,
           CASE WHEN EXISTS (SELECT 1 FROM credit_note_allocations x
                             WHERE x.credit_note_id = d.id AND x.company_id = ${companyId}::UUID)
                THEN (SELECT SUM(x.amount_allocated) FROM credit_note_allocations x
                      WHERE x.credit_note_id = d.id AND x.company_id = ${companyId}::UUID)
                WHEN ${sql.unsafe(shape.noteLink)} IS NOT NULL THEN d.applied_amount
                ELSE 0 END AS trail_allocated,
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
  // A supplier payment released in a BATCH carries no journal of its own:
  // processBatch posts ONE journal on the batch row. Its effective journal is
  // its own, else its batch's (customer receipts have no batch).
  const effective = side === 'ap'
    ? sql`SELECT COALESCE(d.gl_journal_entry_id, (
            SELECT b.gl_journal_entry_id FROM supplier_payment_batches b
            WHERE b.id = d.batch_id AND b.company_id = ${companyId}::UUID)) AS jid`
    : sql`SELECT d.gl_journal_entry_id AS jid`;
  const rows = (await sql`
    SELECT d.id, d.payment_number AS number, d.payment_date AS doc_date, d.status,
           d.total_amount AS total, d.payment_method AS method, pj.jid AS journal_id,
           COALESCE((SELECT SUM(x.amount_allocated) FROM ${sql.unsafe(shape.paymentAlloc)} x
                     JOIN ${sql.unsafe(shape.invoices)} ON ${sql.unsafe(shape.invoiceAlias)}.id = x.invoice_id
                          AND ${sql.unsafe(shape.invoiceAlias)}.company_id = ${companyId}::UUID
                     WHERE x.payment_id = d.id
                       AND ${sql.unsafe(shape.invoiceDate)} <= ${asAtDate}::DATE
                       AND ${sql.unsafe(documentInPopulationExpr(shape.invoiceAlias))}), 0) AS allocated,
           jr.head_status, jr.head_date, jr.ctrl_net, jr.ctrl_lines, jr.reversals, jr.non_control
    FROM ${sql.unsafe(shape.payments)} d
    LEFT JOIN LATERAL (${effective}) pj ON TRUE
    LEFT JOIN LATERAL (
      ${journalChainLateral({ companyId, asAtDate, controlIds, side, link: 'pj.jid' })}
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
