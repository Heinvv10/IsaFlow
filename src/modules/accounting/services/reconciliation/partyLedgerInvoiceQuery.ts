/**
 * The party's invoices (customer) or bills (supplier) for the ledger check,
 * with the settlement the subledger records and the allocation rows that
 * should support it.
 *
 * `eff_paid` is `effectivePaidExpr` over the same `rewindAmount` lateral the
 * aging and the subledger snapshot use -- imported, not restated -- and the
 * population and ledger-presence rules are the shared ones, so a row here is
 * open exactly when `aged_debtors` / `aged_creditors` says it is. `allocated`
 * is NOT a balance: it is the sum of the rows that justify a settlement
 * (payment allocations, credit-note allocations, the pre-677 link, approved
 * write-offs), kept apart so `amount_paid` can be tested against its evidence.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { effectivePaidExpr, rewindAmount } from '../shared/agingRewind';
import { documentInLedgerAsAtFragment } from '../shared/softDeleteLedgerPresence';
import { documentInPopulationExpr } from '../shared/documentPopulation';
import { journalChainLateral, parseJournalFacts } from './partyLedgerJournalLateral';
import type { JournalFacts } from './partyLedgerTypes';

export interface RawInvoice {
  id: string;
  number: string | null;
  date: string;
  status: string | null;
  total: number;
  effectivePaid: number;
  allocated: number;
  inPopulation: boolean;
  journal: JournalFacts;
}

export interface PartyQueryArgs {
  companyId: string;
  partyId: string;
  asAtDate: string;
  todayStr: string;
  controlIds: string[];
}

const LIVE_CREDIT = "('approved', 'partially_applied', 'applied')";

function toInvoice(r: DbRow): RawInvoice {
  return {
    id: String(r.id),
    number: r.number == null ? null : String(r.number),
    date: fmtDate(r.doc_date as string | Date),
    status: r.status == null ? null : String(r.status),
    total: Number(r.total ?? 0),
    effectivePaid: Number(r.eff_paid ?? 0),
    allocated: Number(r.allocated ?? 0),
    inPopulation: r.in_population === true,
    journal: parseJournalFacts(r, r.journal_id),
  };
}

export async function readPartyInvoices(side: 'ar' | 'ap', a: PartyQueryArgs): Promise<RawInvoice[]> {
  const { companyId, partyId, asAtDate, todayStr, controlIds } = a;
  const rows = (await (side === 'ar'
    ? sql`
      SELECT ci.id, ci.invoice_number AS number,
             COALESCE(ci.invoice_date, ci.created_at::date) AS doc_date, ci.status,
             ci.total_amount AS total, ci.gl_journal_entry_id AS journal_id,
             ${sql.unsafe(effectivePaidExpr('ar'))} AS eff_paid,
             ${sql.unsafe(documentInPopulationExpr('ci'))} AS in_population,
             COALESCE((
               SELECT SUM(x.amount_allocated) FROM customer_payment_allocations x
               JOIN customer_payments p ON p.id = x.payment_id
               WHERE x.invoice_id = ci.id AND p.company_id = ${companyId}::UUID
                 AND p.status NOT IN ('draft', 'cancelled') AND p.payment_date <= ${asAtDate}::DATE
             ), 0)
             + COALESCE((
               SELECT SUM(cna.amount_allocated) FROM credit_note_allocations cna
               JOIN credit_notes cn ON cn.id = cna.credit_note_id
               WHERE cna.invoice_id = ci.id AND cna.company_id = ${companyId}::UUID
                 AND cn.type = 'customer' AND cn.status IN ${sql.unsafe(LIVE_CREDIT)}
                 AND cn.credit_date <= ${asAtDate}::DATE
             ), 0)
             + COALESCE((
               SELECT SUM(cn.applied_amount) FROM credit_notes cn
               WHERE cn.customer_invoice_id = ci.id AND cn.company_id = ${companyId}::UUID
                 AND cn.type = 'customer' AND cn.status IN ${sql.unsafe(LIVE_CREDIT)}
                 AND cn.credit_date <= ${asAtDate}::DATE
                 AND NOT EXISTS (SELECT 1 FROM credit_note_allocations n2
                                 WHERE n2.credit_note_id = cn.id AND n2.company_id = ${companyId}::UUID)
             ), 0)
             + COALESCE((
               SELECT SUM(wo.amount) FROM customer_write_offs wo
               WHERE wo.invoice_id = ci.id AND wo.company_id = ${companyId}::UUID
                 AND wo.status = 'approved' AND wo.write_off_date <= ${asAtDate}::DATE
             ), 0) AS allocated,
             jr.head_status, jr.head_date, jr.ctrl_net, jr.ctrl_lines, jr.reversals, jr.non_control
      FROM customer_invoices ci
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr: asAtDate, todayStr, side: 'ar' })}
      ) unpaid ON TRUE
      LEFT JOIN LATERAL (
        ${journalChainLateral({ companyId, asAtDate, controlIds, side: 'ar', link: 'ci.gl_journal_entry_id' })}
      ) jr ON TRUE
      WHERE ci.company_id = ${companyId}::UUID
        AND COALESCE(ci.client_id, ci.customer_id) = ${partyId}::UUID
        AND ${documentInLedgerAsAtFragment('ci', asAtDate, companyId)}
        AND COALESCE(ci.invoice_date, ci.created_at::date) <= ${asAtDate}::DATE
      ORDER BY COALESCE(ci.invoice_date, ci.created_at::date), ci.id`
    : sql`
      SELECT si.id, si.invoice_number AS number,
             COALESCE(si.invoice_date, si.created_at::date) AS doc_date, si.status,
             si.total_amount AS total, si.gl_journal_entry_id AS journal_id,
             ${sql.unsafe(effectivePaidExpr('ap'))} AS eff_paid,
             ${sql.unsafe(documentInPopulationExpr('si'))} AS in_population,
             COALESCE((
               SELECT SUM(x.amount_allocated) FROM payment_allocations x
               JOIN supplier_payments p ON p.id = x.payment_id
               WHERE x.invoice_id = si.id AND p.company_id = ${companyId}::UUID
                 AND p.status NOT IN ('draft', 'cancelled') AND p.payment_date <= ${asAtDate}::DATE
             ), 0)
             + COALESCE((
               SELECT SUM(cna.amount_allocated) FROM credit_note_allocations cna
               JOIN credit_notes cn ON cn.id = cna.credit_note_id
               WHERE cna.invoice_id = si.id AND cna.company_id = ${companyId}::UUID
                 AND cn.type = 'supplier' AND cn.status IN ${sql.unsafe(LIVE_CREDIT)}
                 AND cn.credit_date <= ${asAtDate}::DATE
             ), 0)
             + COALESCE((
               SELECT SUM(cn.applied_amount) FROM credit_notes cn
               WHERE cn.supplier_invoice_id = si.id AND cn.company_id = ${companyId}::UUID
                 AND cn.type = 'supplier' AND cn.status IN ${sql.unsafe(LIVE_CREDIT)}
                 AND cn.credit_date <= ${asAtDate}::DATE
                 AND NOT EXISTS (SELECT 1 FROM credit_note_allocations n2
                                 WHERE n2.credit_note_id = cn.id AND n2.company_id = ${companyId}::UUID)
             ), 0) AS allocated,
             jr.head_status, jr.head_date, jr.ctrl_net, jr.ctrl_lines, jr.reversals, jr.non_control
      FROM supplier_invoices si
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr: asAtDate, todayStr, side: 'ap' })}
      ) unpaid ON TRUE
      LEFT JOIN LATERAL (
        ${journalChainLateral({ companyId, asAtDate, controlIds, side: 'ap', link: 'si.gl_journal_entry_id' })}
      ) jr ON TRUE
      WHERE si.company_id = ${companyId}::UUID
        AND si.supplier_id = ${partyId}::UUID
        AND ${documentInLedgerAsAtFragment('si', asAtDate, companyId)}
        AND COALESCE(si.invoice_date, si.created_at::date) <= ${asAtDate}::DATE
      ORDER BY COALESCE(si.invoice_date, si.created_at::date), si.id`)) as DbRow[];
  return rows.map(toInvoice);
}
