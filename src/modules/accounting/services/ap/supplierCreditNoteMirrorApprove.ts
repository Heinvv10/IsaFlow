/**
 * The approval-time half of `mirror_bill` (migration 988; brief step 5b, Hein 2026-11-13 option A).
 *
 * A mirrored supplier note's VAT was fixed at create from the bill as it stood then. A note or a journal posted
 * against the bill since can make approving it reverse VAT twice. So approveCreditNote, under the bill's credit-note
 * key it already holds and before any write, RE-RUNS the create planner (supplierCreditNoteMirror.planMirroredNote)
 * for this note's subtotal against the bill as it stands now (review round 1, A3). Other open DRAFTS are not netted
 * off here, unlike at create: they have not posted, so they cannot make this posting a double reversal, and netting
 * them would let two drafts that together over-commit the bill block each other for ever. The first to be approved
 * wins; the next is judged against the bill with the first posted.
 *   'mirror_bill'      refused when the planner refuses, or when the note's tax exceeds what it would now give
 *                      (by more than a cent);
 *   'mirror_bill_ack'  refused when the planner refuses the acknowledged amount (more than the bill's derivable VAT
 *                      on this share, or no base left), AND when any heuristic match that moves the bill's VAT
 *                      entered the ledger after the note was written (review rounds 2-3): the later of a journal's
 *                      created_at and posted_at, so a draft written before the note and posted after it counts; the
 *                      acknowledgement covered only the journals the caller was shown. Remaining limits: both stamps are
 *                      transaction-start times (NOW()), so a journal posted by a transaction that began before the
 *                      note's and committed after it reads as earlier; and an edit to a posted journal that adds no
 *                      journal to its chain is not seen.
 * 'rate' notes are not checked: unchanged.
 *
 * `mirroredVatRefusals` is the same judgement for a batch, read before anything posts, so the
 * bulk_approve_credit_notes dry run and its live call skip the same notes: it walks the batch in the live order, and
 * every supplier note on the bill that would post takes its subtotal and VAT off the bill for the notes after it.
 */
import { sql, type DbRow } from '@/lib/neon';
import { getDocumentVatHistory, type DocumentVatHistory } from '../reports/documentVatHistory';
import { NO_ACK, planMirroredNote } from './supplierCreditNoteMirror';

export const VAT_TOLERANCE = 0.01;
const r2 = (n: number): number => Math.round(n * 100) / 100;
/** ISO timestamp of a pg timestamptz (Date) or string; the epoch when absent, so nothing reads as written after it. */
/** The stored acknowledged-match list (JSONB: pg returns it parsed), or null. */
export function ackMatchesOf(v: unknown): MirroredNoteState['ackMatches'] {
  if (!Array.isArray(v)) return null;
  return v.map((m: { journal_entry_id?: unknown; vat_amount?: unknown }) => ({ journal_entry_id: String(m.journal_entry_id), vat_amount: Number(m.vat_amount) }));
}
export const isoOf = (v: unknown): string => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : new Date(0).toISOString());

export class MirroredNoteVatRefusal extends Error {
  readonly code = 'VAT_ALREADY_REVERSED';
  constructor(message: string) {
    super(message);
    this.name = 'MirroredNoteVatRefusal';
  }
}

export interface MirroredNoteState {
  id: string;
  /** When the note was written: an acknowledgement covers only journals written before it. */
  createdAt: string;
  /** 'mirror_bill_ack': the matches acknowledged at create (migration 988), else null. */
  ackMatches?: { journal_entry_id: string; vat_amount: number }[] | null;
  number: string;
  type: string;
  billId: string | null;
  subtotal: number;
  taxAmount: number;
  vatBasis: string;
}

const isMirrored = (n: MirroredNoteState): boolean =>
  (n.vatBasis === 'mirror_bill' || n.vatBasis === 'mirror_bill_ack') && n.type === 'supplier' && n.billId !== null;

const REMEDY = 'Nothing was posted. Cancel this draft with cancel_credit_note. If the journals named above are about this '
  + 'bill, raise it again with mirror_bill, acknowledge_vat_already_reversed: true and the vat_amount the refusal '
  + 'suggests; if a match is about another document, a person must decide (document_vat_history lists each journal and its tie).';

/** Pure: why this mirrored note may not be approved against the bill as `h` stands (posted journals only), or null. */
export function judgeMirroredApproval(h: DocumentVatHistory, note: MirroredNoteState): string | null {
  const acknowledged = note.vatBasis === 'mirror_bill_ack';
  const d = planMirroredNote(h, note.subtotal, acknowledged ? { acknowledged, vatAmount: note.taxAmount } : NO_ACK);
  const head = `VAT_ALREADY_REVERSED: credit note ${note.number} was raised with mirror_bill on bill ${h.document_number}, which has changed since. `;
  if (!d.ok) return `${head}${d.reason.replace(/^VAT_ALREADY_REVERSED: /, '')} ${REMEDY}`;
  if (acknowledged && h.heuristic.truncated) {
    // A match past MATCH_LIMIT is invisible to the acknowledged-set check below (review round 5).
    return `${head}More than ${h.heuristic.limit} journals name the bill, so the acknowledged journals cannot be checked against them. ${REMEDY}`;
  }
  if (acknowledged) {
    // In place (review round 4, R4-1): an account merge or a VAT-code edit can bring a journal into the match set, or
    // change what a known one moves, without touching any timestamp — so the acknowledged set itself is compared.
    const known = new Map((note.ackMatches ?? []).map((m) => [m.journal_entry_id, Number(m.vat_amount)]));
    const unacknowledged = h.heuristic.matches.filter((m) => Math.abs(m.vat_amount) > 0.01
      && (!known.has(m.journal_entry_id) || Math.abs(known.get(m.journal_entry_id)! - m.vat_amount) > 0.01));
    if (unacknowledged.length > 0) {
      const named = unacknowledged.map((m) => `${m.entry_number ?? m.journal_entry_id} [${m.source ?? 'no source'}] ${m.tie} ${m.vat_amount}`).join('; ');
      return `${head}Journals naming the bill now move its VAT differently from what was acknowledged (${named}). ${REMEDY}`;
    }
    const since = h.heuristic.matches.filter((m) => Math.abs(m.vat_amount) > 0.01 && m.last_written_at > note.createdAt);
    if (since.length > 0) {
      const named = since.map((m) => `${m.entry_number ?? m.journal_entry_id} [${m.source ?? 'no source'}] ${m.tie} ${m.vat_amount}`).join('; ');
      return `${head}Journals naming the bill and moving its VAT were written after the acknowledgement (${named}); `
        + `it covered only the journals shown when the note was raised. ${REMEDY}`;
    }
  }
  if (!acknowledged && r2(note.taxAmount - d.plan.taxAmount) > VAT_TOLERANCE) {
    const named = d.plan.adjustingJournals.map((j) => `${j.entry_number ?? '(unnumbered)'} ${j.tie} ${j.vat_amount}`).join('; ');
    return `${head}It would reverse ${note.taxAmount} of VAT; the bill now gives ${d.plan.taxAmount} on this subtotal `
      + `(${named || 'no journal named'}). ${REMEDY}`;
  }
  return null;
}

/** Throws MirroredNoteVatRefusal for a mirrored note the bill can no longer carry. Call under the bill's key, pre-write. */
export async function assertMirroredNoteVatStands(companyId: string, note: MirroredNoteState): Promise<void> {
  if (!isMirrored(note)) return;
  const h = await getDocumentVatHistory(companyId, 'supplier_invoice', note.billId!);
  if (!h) return;
  const why = judgeMirroredApproval(h, note);
  if (why) throw new MirroredNoteVatRefusal(why);
}

/** The notes of a batch, keyed by id (company-scoped). */
export async function readMirrorStates(companyId: string, ids: readonly string[]): Promise<Map<string, MirroredNoteState>> {
  const rows = (await sql`
    SELECT id, credit_note_number, type, supplier_invoice_id, subtotal, tax_amount, vat_basis, created_at, vat_ack_matches FROM credit_notes
    WHERE company_id = ${companyId}::UUID AND id = ANY(${[...ids]}::UUID[])`) as DbRow[];
  return new Map(rows.map((r) => [String(r.id), {
    id: String(r.id), number: String(r.credit_note_number ?? r.id), type: String(r.type),
    billId: r.supplier_invoice_id == null ? null : String(r.supplier_invoice_id),
    subtotal: Number(r.subtotal ?? 0), taxAmount: Number(r.tax_amount ?? 0), vatBasis: String(r.vat_basis ?? 'rate'),
    createdAt: isoOf(r.created_at),
    ackMatches: ackMatchesOf(r.vat_ack_matches),
  }]));
}

/** The bill as it will stand once `n` has posted: its base and VAT less the note's. */
function afterPosting(h: DocumentVatHistory, n: MirroredNoteState): DocumentVatHistory {
  const t = h.totals;
  return { ...h, totals: { ...t, net_base_now: r2(t.net_base_now - n.subtotal),
    vat_derivable_now: r2(t.vat_derivable_now - n.taxAmount), vat_net_now: r2(t.vat_net_now - n.taxAmount) } };
}

/** id → refusal text for each mirrored note of `orderedIds` (the live posting order) the bill cannot carry at its turn. */
export async function mirroredVatRefusals(companyId: string, orderedIds: readonly string[]): Promise<Map<string, string>> {
  const states = await readMirrorStates(companyId, orderedIds);
  const notes = orderedIds.map((id) => states.get(id)).filter((n): n is MirroredNoteState => Boolean(n));
  const bills = new Map<string, { h: DocumentVatHistory }>();
  for (const billId of new Set(notes.filter(isMirrored).map((n) => n.billId!))) {
    const h = await getDocumentVatHistory(companyId, 'supplier_invoice', billId);
    if (h) bills.set(billId, { h });
  }
  const refusals = new Map<string, string>();
  for (const n of notes) {
    const bill = n.type === 'supplier' && n.billId ? bills.get(n.billId) : undefined;
    if (!bill) continue;
    if (isMirrored(n)) {
      const why = judgeMirroredApproval(bill.h, n);
      if (why) { refusals.set(n.id, why); continue; }
    }
    bill.h = afterPosting(bill.h, n);
  }
  return refusals;
}
