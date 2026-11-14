/**
 * Finds the journals the party's documents SHARE with other documents, and
 * replaces each document's whole-journal facts with its own provable leg (or
 * marks it unattributable). The rule is `partyLedgerSharedAttribution`.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { attributeSharedJournal, type SharedRef } from './partyLedgerSharedAttribution';
import type { JournalFacts } from './partyLedgerTypes';

interface RefRow extends SharedRef {
  journalId: string;
  viaBatch: boolean;
}

/** Every document in the company that carries one of these journals, any party, any kind. */
async function readRefs(side: 'ar' | 'ap', companyId: string, journalIds: string[]): Promise<RefRow[]> {
  const isAr = side === 'ar';
  const rows = (await sql`
    SELECT gl_journal_entry_id AS jid, id, false AS via_batch,
           CASE WHEN ${isAr}::boolean THEN total_amount END AS expected
    FROM customer_invoices WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ANY(${journalIds}::uuid[])
    UNION ALL
    SELECT gl_journal_entry_id, id, false, CASE WHEN NOT ${isAr}::boolean THEN total_amount END
    FROM supplier_invoices WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ANY(${journalIds}::uuid[])
    UNION ALL
    SELECT gl_journal_entry_id, id, false, CASE WHEN ${isAr}::boolean THEN -total_amount END
    FROM customer_payments WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ANY(${journalIds}::uuid[])
    UNION ALL
    SELECT gl_journal_entry_id, id, false, CASE WHEN NOT ${isAr}::boolean THEN -total_amount END
    FROM supplier_payments WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ANY(${journalIds}::uuid[])
    UNION ALL
    SELECT b.gl_journal_entry_id, sp.id, true, CASE WHEN NOT ${isAr}::boolean THEN -sp.total_amount END
    FROM supplier_payments sp
    JOIN supplier_payment_batches b ON b.id = sp.batch_id AND b.company_id = ${companyId}::UUID
    WHERE sp.company_id = ${companyId}::UUID AND sp.gl_journal_entry_id IS NULL
      AND b.gl_journal_entry_id = ANY(${journalIds}::uuid[])
    UNION ALL
    SELECT gl_journal_entry_id, id, false,
           CASE WHEN (type = 'customer') = ${isAr}::boolean THEN -total_amount END
    FROM credit_notes WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ANY(${journalIds}::uuid[])
    UNION ALL
    SELECT gl_journal_entry_id, id, false, CASE WHEN ${isAr}::boolean THEN -amount END
    FROM customer_write_offs WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ANY(${journalIds}::uuid[])
  `) as DbRow[];
  return rows.map((r) => ({
    journalId: String(r.jid),
    id: String(r.id),
    viaBatch: r.via_batch === true,
    expected: r.expected == null ? null : Number(r.expected),
  }));
}

async function readHeadLines(
  side: 'ar' | 'ap', companyId: string, asAtDate: string, controlIds: string[], journalIds: string[],
): Promise<Map<string, number[]>> {
  const orient = side === 'ar' ? 'jl.debit - jl.credit' : 'jl.credit - jl.debit';
  const rows = (await sql`
    SELECT je.id AS jid, (${sql.unsafe(orient)}) AS v
    FROM gl_journal_entries je
    JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
                            AND jl.gl_account_id = ANY(${controlIds}::uuid[])
    WHERE je.company_id = ${companyId}::UUID AND je.id = ANY(${journalIds}::uuid[])
      AND je.status = 'posted' AND je.entry_date <= ${asAtDate}::DATE
  `) as DbRow[];
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const key = String(r.jid);
    out.set(key, [...(out.get(key) ?? []), Number(r.v)]);
  }
  return out;
}

export interface JournalHolder {
  id: string;
  journal: JournalFacts;
}

export interface SharedResolution {
  journal: JournalFacts;
  attribution: 'own' | 'line_match' | 'batch_total' | 'unattributable';
  sharedWith: string[];
}

/**
 * @returns for each of the party's documents (by id) its journal facts as the
 *   document's own: unchanged when it holds the journal alone.
 */
export async function resolveSharedJournals(
  side: 'ar' | 'ap', companyId: string, asAtDate: string, controlIds: string[], holders: readonly JournalHolder[],
): Promise<Map<string, SharedResolution>> {
  const out = new Map<string, SharedResolution>();
  const journalIds = [...new Set(holders.flatMap((h) => (h.journal.journalId ? [h.journal.journalId] : [])))];
  const refs = journalIds.length === 0 ? [] : await readRefs(side, companyId, journalIds);
  const byJournal = new Map<string, RefRow[]>();
  for (const r of refs) byJournal.set(r.journalId, [...(byJournal.get(r.journalId) ?? []), r]);
  const sharedIds = [...byJournal.entries()].filter(([, rs]) => rs.length > 1).map(([id]) => id);
  const heads = sharedIds.length === 0 || controlIds.length === 0
    ? new Map<string, number[]>()
    : await readHeadLines(side, companyId, asAtDate, controlIds, sharedIds);

  for (const h of holders) {
    const jid = h.journal.journalId;
    const group = jid ? byJournal.get(jid) : undefined;
    if (!jid || !group || group.length < 2) {
      out.set(h.id, { journal: h.journal, attribution: 'own', sharedWith: [] });
      continue;
    }
    const result = attributeSharedJournal({
      headLines: heads.get(jid) ?? [],
      chainNet: h.journal.controlNet,
      refs: group,
      isBatch: group.every((r) => r.viaBatch),
    });
    const sharedWith = group.filter((r) => r.id !== h.id).map((r) => r.id);
    const leg = result.kind === 'attributed' ? result.legs.get(h.id) : undefined;
    if (result.kind === 'attributed' && leg !== undefined) {
      const lines = (heads.get(jid) ?? []).length > 0 ? 1 : 0;
      out.set(h.id, {
        journal: { ...h.journal, controlNet: leg, controlLines: lines, nonControl: [] },
        attribution: result.basis,
        sharedWith,
      });
    } else {
      out.set(h.id, {
        journal: { ...h.journal, controlNet: 0, controlLines: 0, nonControl: [] },
        attribution: 'unattributable',
        sharedWith,
      });
    }
  }
  return out;
}
