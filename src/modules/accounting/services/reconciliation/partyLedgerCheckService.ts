/**
 * `party_ledger_check`: one supplier's or customer's statement, aged balance and
 * GL control-account movement, document by document.
 *
 * REUSE, NOT A SECOND FORMULA. The statement balance is
 * `fetchStatementData` / `fetchSupplierStatementData` (the services behind
 * `customer_statement` / `supplier_statement`); the aged view is
 * `fetchARAgingInvoices` / `fetchAPAgingInvoices` (behind `aged_debtors` /
 * `aged_creditors`, with `agingRewind` for the point in time); the control
 * accounts are `getControlAccountBalances` (by subtype, like
 * `reconcile_subledger`). A statement line is joined to its document by id.
 * What this file adds is the per-document GL net -- the document's OWN journal
 * chain on the control accounts -- and the comparison, so a gap is a named
 * document rather than a total.
 *
 * WHAT IT CANNOT SEE. A bare journal names no party, so "journal with no
 * document" cannot be attributed to one. Company-wide such journals are counted
 * on `unattributed`, labelled as company scope, and are NOT part of the party's
 * totals. A party total that ties is not proof the books are right: read the
 * documents.
 */
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { fetchARAgingInvoices } from '../ar/arAgingInvoices';
import { fetchAPAgingInvoices } from '../ap/apAgingInvoices';
import { getControlAccountBalances } from '../gl/controlAccountService';
import { getLedgerPostedThrough } from '../reports/postedThroughService';
import { buildDocument, type DocumentInput } from './partyLedgerClassify';
import { buildTotals, checkPartyInvariants } from './partyLedgerTotals';
import { readPartyInvoices, type PartyQueryArgs } from './partyLedgerInvoiceQuery';
import {
  readPartyCreditNotes,
  readPartyPayments,
  readPartyWriteOffs,
  type RawSettlement,
} from './partyLedgerSettlementQueries';
import { resolveSharedJournals, type JournalHolder } from './partyLedgerSharedJournals';
import { readStatement, statementFields } from './partyLedgerStatementView';
import { assertPartySize } from './partyLedgerSize';
import { readOrphanControlPostings } from './orphanControlPostings';
import { dropCancelledReversalPairs } from './orphanReversalPairs';
import { round2 } from './reconciliationMath';
import type {
  PartyDocKind,
  PartyDocument,
  PartyLedgerCheck,
  PartyType,
  UnattributedControlPostings,
} from './partyLedgerTypes';

export { PartyTooLargeError } from './partyLedgerSize';

const EPOCH = '1970-01-01T00:00:00.000Z';
const KIND_ORDER: Record<PartyDocKind, string> = { invoice: '0', credit_note: '1', payment: '2', write_off: '3' };

export function documentSortKey(d: Pick<PartyDocument, 'date' | 'kind' | 'id'>): string[] {
  return [d.date, KIND_ORDER[d.kind], d.id];
}

async function readUnattributed(
  companyId: string, side: 'ar' | 'ap', asAt: string, ids: string[],
): Promise<UnattributedControlPostings> {
  if (ids.length === 0) return { scope: 'company', count: 0, net: 0 };
  // A batch's journal is claimed by its member payments (processBatch writes it on the
  // batch row only), so it is not a journal "no document" carries.
  const batchJournals = new Set(((await sql`
    SELECT gl_journal_entry_id AS id FROM supplier_payment_batches
    WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id IS NOT NULL`) as Array<{ id: string }>).map((r) => String(r.id)));
  const rows = dropCancelledReversalPairs(await readOrphanControlPostings(companyId, side === 'ar', asAt, ids))
    .filter((r) => !batchJournals.has(String(r.id)));
  // control_credit is what must be ADDED to the control balance to reach the subledger,
  // so the journal's own movement in the statement orientation is its negation.
  return { scope: 'company', count: rows.length, net: round2(-rows.reduce((s, r) => s + Number(r.control_credit ?? 0), 0)) };
}

export async function partyLedgerCheck(
  companyId: string,
  partyType: PartyType,
  partyId: string,
  asAtDate: string,
): Promise<PartyLedgerCheck | null> {
  try {
    const side = partyType === 'customer' ? 'ar' : 'ap';
    // SEQUENTIAL: every read runs on the one pg client the request's transaction holds.
    await assertPartySize(side, companyId, partyId, asAtDate);
    const view = await readStatement(companyId, partyType, partyId, asAtDate);
    if (!view) return null;

    const controlAccounts = await getControlAccountBalances(companyId, side, asAtDate);
    const controlIds = controlAccounts.map((a) => a.accountId);
    const glAvailable = controlIds.length > 0;
    const todayStr = fmtDate(new Date());
    const q: PartyQueryArgs = { companyId, partyId, asAtDate, todayStr, controlIds };

    const aged = side === 'ar'
      ? await fetchARAgingInvoices(companyId, asAtDate, todayStr, partyId)
      : await fetchAPAgingInvoices(companyId, asAtDate, todayStr, partyId);
    const agedById = new Map(aged.map((a) => [a.id, a.balance]));
    const agedNet = aged.reduce((s, a) => s + a.balance, 0);

    const invoices = await readPartyInvoices(side, q);
    const notes = await readPartyCreditNotes(side, q);
    const payments = await readPartyPayments(side, q);
    const writeOffs = side === 'ar' ? await readPartyWriteOffs(q) : [];

    // A journal several documents carry is split to each one's provable leg, or left out.
    const holders: JournalHolder[] = [...invoices, ...notes, ...payments, ...writeOffs]
      .map((r) => ({ id: r.id, journal: r.journal }));
    const shared = await resolveSharedJournals(side, companyId, asAtDate, controlIds, holders);
    const own = (id: string) => shared.get(id)!;

    const base = { asAt: asAtDate, glAvailable };
    const inputs: DocumentInput[] = [];
    for (const r of invoices) {
      inputs.push({
        ...base, kind: 'invoice', id: r.id, number: r.number, date: r.date, status: r.status,
        total: r.total, journal: own(r.id).journal, attribution: own(r.id).attribution, sharedWith: own(r.id).sharedWith,
        ...statementFields(view, r.id, 'not_in_statement'),
        settled: r.effectivePaid, outstanding: agedById.get(r.id) ?? 0,
        allocated: r.allocated, unapplied: null, checkTrail: r.inPopulation,
      });
    }
    const settlement = (kind: PartyDocKind, r: RawSettlement, noStatement: string): DocumentInput => {
      const st = statementFields(view, r.id, noStatement);
      let unapplied: number | null = null;
      if (st.onStatement && kind === 'payment') unapplied = r.total - r.allocated;
      if (st.onStatement && kind === 'credit_note') unapplied = -st.statementEffect - r.allocated;
      return {
        ...base, kind, id: r.id, number: r.number, date: r.date, status: r.status,
        total: r.total, journal: own(r.id).journal, attribution: own(r.id).attribution, sharedWith: own(r.id).sharedWith, ...st,
        settled: kind === 'credit_note' ? r.applied : null, outstanding: null,
        allocated: kind === 'write_off' ? null : r.allocated,
        trailAllocated: kind === 'credit_note' ? r.trailAllocated : undefined,
        unapplied, checkTrail: kind === 'credit_note',
      };
    };
    for (const r of notes) inputs.push(settlement('credit_note', r, 'not_in_statement'));
    for (const r of payments) inputs.push(settlement('payment', r, 'not_in_statement'));
    for (const r of writeOffs) inputs.push(settlement('write_off', r, 'write_offs_are_not_listed_on_statements'));

    const documents = inputs.map(buildDocument).sort((a, b) => {
      const ka = documentSortKey(a);
      const kb = documentSortKey(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
      return 0;
    });

    const totals = buildTotals({ documents, statementBalance: view.balance, agedNet, glAvailable });
    const invoiceOpenFromRows = invoices
      .filter((r) => r.inPopulation)
      .reduce((s, r) => s + Math.max(r.total - r.effectivePaid, 0), 0);
    const invariants = checkPartyInvariants({ documents, totals, invoiceOpenFromRows, glAvailable });
    const unattributed = await readUnattributed(companyId, side, asAtDate, controlIds);
    const ledger = await getLedgerPostedThrough(companyId, asAtDate);

    return {
      partyType,
      party: { id: partyId, name: view.name },
      as_at: asAtDate,
      controlAccounts: controlAccounts.map((a) => ({
        accountId: a.accountId, accountCode: a.accountCode, accountName: a.accountName, balance: a.balance,
      })),
      totals,
      documents,
      invariants,
      unattributed,
      postedThrough: ledger === EPOCH ? null : ledger,
    };
  } catch (err) {
    log.error('Failed to run the party ledger check', { partyType, error: err }, 'accounting');
    throw err;
  }
}
