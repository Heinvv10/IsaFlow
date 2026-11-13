/**
 * The pure half of document_vat_history: the whole-token pattern, which numbers are searched, the document's
 * direction, and the lines and totals built from the journal rows (documentVatHistoryQuery).
 *
 * DERIVABLE vs HEURISTIC (review round 1, A2). posting, late_claim, reversal and credit_note are ties the data
 * states; reference_match and narration_match are guesses from narration. The derivable figures
 * (`vat_derivable_now`, `net_base_now`) are what a mirrored credit note may WRITE; a heuristic match can only
 * reduce the reported `vat_net_now` (never raise it) and can only make mirror_bill refuse. Every VAT line of a
 * matched journal counts (the VAT201's member rule). Each match (a matched journal with its reversal chain) is judged
 * ON ITS OWN (review round 2, R2-1): an unrelated journal that names the same number and ADDS VAT must not cancel a
 * real hand reversal, so `vat_net_now` = derivable + the sum of each match's NEGATIVE net only.
 *
 * Base (A5): a leg is base when 892's `isBillExpenseLeg` says the approval would credit it AND it is not VAT —
 * the VAT201 member rule, or the s16(3) late-claim clearing leg, which 892 still reads as an expense leg.
 */
import { fmtDate } from '@/lib/fmtDate';
import { isBillExpenseLeg } from '../ap/supplierCreditNoteExpenseLines';
import type { DocumentVatEntityType, DocumentVatTie, JournalLineRow } from './documentVatHistoryQuery';

const TIE_RANK: Record<DocumentVatTie, number> = {
  posting: 0, late_claim: 1, reversal: 2, credit_note: 3, reference_match: 4, narration_match: 5,
};
export const DERIVABLE_TIES: ReadonlySet<DocumentVatTie> = new Set(['posting', 'late_claim', 'reversal', 'credit_note']);
/** Longest number searched: past it, the regex the database builds grows without bound (security review). */
export const MAX_TOKEN_LENGTH = 64;

export interface DocumentVatLine {
  journal_entry_id: string;
  /** The root of this journal's chain: the matched journal for a heuristic tie, the posting / note journal otherwise. */
  root_journal_id: string;
  entry_number: string | null;
  entry_date: string;
  source: string | null;
  status: string;
  /** The journal no longer stands: its reversal chain has an odd number of posted reversals. */
  reversed: boolean;
  /** The journal this one reverses (a chain member), else null. */
  reverses_journal_id: string | null;
  tie: DocumentVatTie;
  /** credit_note: the note's number. */
  tied_via: string | null;
  /** Heuristic ties: reference, narration and/or line_narration. */
  matched_in: string | null;
  gl_account_id: string;
  account_code: string | null;
  account_name: string | null;
  vat_type: string | null;
  /** Signed in the document's direction. */
  vat_amount: number;
  /** The journal's net base when it has exactly one VAT line and a derivable tie. */
  net_base: number | null;
  description: string | null;
}

/** One heuristic match: a matched journal and its reversal chain, netted. */
export interface HeuristicMatch {
  journal_entry_id: string;
  entry_number: string | null;
  tie: DocumentVatTie;
  /** Its chain's VAT on the document's own VAT accounts, in the document's direction. */
  vat_amount: number;
  /** The root journal's source: a match may be another document's own posting (a payment, a claim, a provisional). */
  source: string | null;
  /** The latest time any journal in its chain entered the ledger (created or posted, whichever is later), ISO. */
  last_written_at: string;
}

export interface DocumentVatTotals {
  /** The document's own VAT: its posting and its late-claim companion. */
  vat_posted: number;
  vat_reversed: number;
  /** Derivable VAT, reduced (never raised) by heuristic matches. */
  vat_net_now: number;
  /** posting + late_claim + reversal + credit_note: what the data itself says the document carries. */
  vat_derivable_now: number;
  /** The heuristic ties' VAT on the document's own VAT accounts, all matches netted (signed). */
  vat_heuristic: number;
  /** The sum of each match's net where it is negative: what the heuristic takes off (<= 0). */
  vat_heuristic_reducing: number;
  vat_by_tie: Record<DocumentVatTie, number>;
  net_base_posted: number;
  /** Derivable ties only. */
  net_base_now: number;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** A number worth searching for: 4 to 64 characters with a digit. */
export function isSearchableToken(token: string): boolean {
  const t = token.trim();
  return t.length >= 4 && t.length <= MAX_TOKEN_LENGTH && /\d/.test(t);
}

/**
 * A case-insensitive (`~*`) whole-token pattern (Postgres ARE). A token ends where the text does, or at a character
 * that is not a letter or digit — unless that is a separator (- / _ . ,) followed by a letter or digit, which keeps
 * the token going: `SIVH-1` does not match inside `SIVH-1-2` or `X-SIVH-1`, nor `123456` inside `123456.50`.
 */
export function tokenPattern(tokens: readonly string[]): string {
  const escaped = tokens.map((t) => t.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `(?<![A-Za-z0-9])(?<![A-Za-z0-9][-/_.,])(?:${escaped.join('|')})(?![A-Za-z0-9])(?![-/_.,][A-Za-z0-9])`;
}

/** +1 when the document's own VAT is a debit (bill, customer credit note), -1 when a credit. */
export function documentDirection(entityType: DocumentVatEntityType, noteType: string | null): 1 | -1 {
  if (entityType === 'supplier_invoice') return 1;
  if (entityType === 'customer_invoice') return -1;
  return noteType === 'customer' ? 1 : -1;
}

/** The accounts the document's own VAT legs sit on (posting + late-claim companion). */
export function documentVatAccountIds(rows: readonly JournalLineRow[]): string[] {
  return [...new Set(rows.filter((r) => r.is_vat === true && (r.root_tie === 'posting' || r.root_tie === 'late_claim'))
    .map((r) => String(r.gl_account_id)))];
}

/**
 * Pure: the lines and totals from the journal rows (each journal counted once, under its strongest tie).
 * `roleAccountIds`: the payable / receivable / VAT system accounts, as 892 reads them.
 */
export function summariseVatLines(rows: readonly JournalLineRow[], direction: 1 | -1, roleAccountIds: ReadonlySet<string>) {
  const tieOf = new Map<string, JournalLineRow>();
  for (const r of rows) {
    const seen = tieOf.get(r.journal_entry_id);
    if (!seen || TIE_RANK[r.root_tie] < TIE_RANK[seen.root_tie]) tieOf.set(r.journal_entry_id, r);
  }
  const seenLine = new Set<string>();
  const byJournal = new Map<string, JournalLineRow[]>();
  for (const r of rows) {
    // A journal reached by two ties comes back once per tie; its lines count once.
    if (seenLine.has(r.line_id)) continue;
    seenLine.add(r.line_id);
    byJournal.set(r.journal_entry_id, [...(byJournal.get(r.journal_entry_id) ?? []), r]);
  }
  const vatByTie: Record<DocumentVatTie, number> = {
    posting: 0, late_claim: 0, reversal: 0, credit_note: 0, reference_match: 0, narration_match: 0,
  };
  let basePosted = 0;
  let baseNow = 0;
  const lines: DocumentVatLine[] = [];
  const matches = new Map<string, HeuristicMatch>();
  const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
  for (const [journalId, jl] of byJournal) {
    const head = tieOf.get(journalId)!;
    const derivable = DERIVABLE_TIES.has(head.root_tie);
    const signed = (r: JournalLineRow) => direction * (Number(r.debit) - Number(r.credit));
    // Every VAT line counts — the VAT201's member rule or the late-claim clearing leg (is_vat), for heuristic ties too
    // (review round 5: a reversal on a generic-tax or VAT-coded balance-sheet account is the same VAT201 figure).
    const vatLines = jl.filter((r) => r.is_vat === true);
    const base = derivable
      ? r2(jl.filter((r) => r.is_vat !== true && isBillExpenseLeg(r, roleAccountIds)).reduce((s, r) => s + signed(r), 0))
      : null;
    if (base !== null) baseNow += base;
    if (base !== null && head.root_tie === 'posting') basePosted += base;
    if (!derivable) {
      const root = String(head.root_journal_id);
      const m = matches.get(root) ?? { journal_entry_id: root, entry_number: null, tie: head.root_tie, source: null, vat_amount: 0, last_written_at: iso(head.written_at) };
      if (journalId === root) { m.entry_number = head.entry_number; m.source = head.source; }
      if (iso(head.written_at) > m.last_written_at) m.last_written_at = iso(head.written_at);
      m.vat_amount = r2(m.vat_amount + vatLines.reduce((s, r) => s + signed(r), 0));
      matches.set(root, m);
    }
    for (const r of vatLines) {
      const vat = r2(signed(r));
      vatByTie[head.root_tie] += vat;
      lines.push({
        journal_entry_id: journalId, root_journal_id: String(head.root_journal_id), entry_number: head.entry_number, entry_date: fmtDate(head.entry_date),
        source: head.source, status: head.status, reversed: head.stands !== true, reverses_journal_id: head.reverses,
        tie: head.root_tie, tied_via: head.via, matched_in: head.matched_in,
        gl_account_id: String(r.gl_account_id), account_code: r.account_code, account_name: r.account_name,
        vat_type: r.vat_type, vat_amount: vat, net_base: vatLines.length === 1 ? base : null,
        description: r.line_description,
      });
    }
  }
  for (const k of Object.keys(vatByTie) as DocumentVatTie[]) vatByTie[k] = r2(vatByTie[k]);
  const vatPosted = r2(vatByTie.posting + vatByTie.late_claim);
  const derivableNow = r2(vatPosted + vatByTie.reversal + vatByTie.credit_note);
  const heuristic = r2(vatByTie.reference_match + vatByTie.narration_match);
  const reducing = r2([...matches.values()].reduce((s, m) => s + Math.min(0, m.vat_amount), 0));
  const netNow = r2(derivableNow + reducing);
  const totals: DocumentVatTotals = {
    vat_posted: vatPosted, vat_reversed: r2(vatPosted - netNow), vat_net_now: netNow, vat_derivable_now: derivableNow,
    vat_heuristic: heuristic, vat_heuristic_reducing: reducing, vat_by_tie: vatByTie,
    net_base_posted: r2(basePosted), net_base_now: r2(baseNow),
  };
  return { lines, totals, matches: [...matches.values()] };
}
