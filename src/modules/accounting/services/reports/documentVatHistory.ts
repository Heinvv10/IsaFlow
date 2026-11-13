/**
 * Every VAT line tied to ONE document — a supplier bill, a customer invoice or
 * a credit note — and the VAT that document carries NOW, after every later
 * journal (MCP `document_vat_history`; brief step 5a, 2026-11-13).
 *
 * Why: the VAT a bill carries is not the VAT its posting journal shows. A
 * reversal, a credit note, or a hand-made journal can move it later, and
 * nothing tied them together. SIV3762 (Velocity Fibre): the 8 Oct slip-review
 * journal JE-2026-26788 reversed its input VAT by hand, CN-557 then reversed
 * it a second time, and JE-2026-31949 had to put R260.87 back.
 *
 * The ties, strongest first (a journal reached two ways is reported once, by
 * the strongest):
 *   posting          the document's own journal (and one sourced from it, DRC);
 *   reversal         a journal in that posting's reversal chain;
 *   credit_note      a LINKED credit note's journal, and its reversal chain
 *                    (a cancelled note's contra);
 *   reference_match  HEURISTIC: a posted VAT-bearing journal whose reference
 *   narration_match  or narration (header or any line) names one of the
 *                    document's numbers as a whole token, and its chain.
 * Credit applied by FIFO from a note NOT linked to the document carries no VAT
 * tie to it and is not read.
 *
 * Signs are in the DOCUMENT'S direction: positive = the way its own posting
 * moved VAT (input VAT claimed for a bill, output VAT raised for an invoice,
 * VAT reversed for a credit note). So vat_posted is the posting, vat_reversed
 * is what every other tie took away (negative when one put VAT back), and
 * vat_net_now = vat_posted - vat_reversed.
 */
import { fmtDate } from '@/lib/fmtDate';
import { canonicalSubtype } from '../gl/accountSubtypes';
import { reportingClassFor } from '../gl/accountReportingClass';
import {
  MATCH_LIMIT, readChainLines, readDocument, readNarrationMatches, readTiedRoots,
  type DocumentVatEntityType, type DocumentVatTie, type JournalLineRow, type RootJournal,
} from './documentVatHistoryQuery';

export { DOCUMENT_VAT_ENTITY_TYPES, type DocumentVatEntityType, type DocumentVatTie } from './documentVatHistoryQuery';

export const HEURISTIC_NOTE =
  'reference_match and narration_match are HEURISTIC: a posted journal with a VAT line whose reference or narration '
  + 'names one of this document\'s numbers as a whole token (case-insensitive; numbers shorter than 4 characters, '
  + 'with no digit, or all digits and shorter than 6 are not searched). A match may be about a different document, '
  + 'and a journal that adjusts this document without naming it is not found. Check each one before relying on it.';

const TIE_RANK: Record<DocumentVatTie, number> = {
  posting: 0, reversal: 1, credit_note: 2, reference_match: 3, narration_match: 4,
};
const DERIVABLE_BASE: ReadonlySet<DocumentVatTie> = new Set(['posting', 'reversal', 'credit_note']);

export interface DocumentVatLine {
  journal_entry_id: string;
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
  /** The journal's net base (non-VAT, non-control legs, same sign) when it has exactly one VAT line and a derivable tie. */
  net_base: number | null;
  description: string | null;
}

export interface DocumentVatHistory {
  entity_type: DocumentVatEntityType;
  entity_id: string;
  document_number: string;
  external_document_number: string | null;
  document_status: string;
  lines: DocumentVatLine[];
  totals: {
    vat_posted: number;
    vat_reversed: number;
    vat_net_now: number;
    vat_by_tie: Record<DocumentVatTie, number>;
    /** Base of the posting journal(s), same sign as VAT. */
    net_base_posted: number;
    /** Posting + reversal + credit-note bases: what the document still carries net. Heuristic ties add none. */
    net_base_now: number;
  };
  heuristic: { tokens: string[]; skipped_tokens: string[]; journals_matched: number; truncated: boolean; limit: number; note: string };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** A number worth searching narration for: 4+ characters with a digit; an all-digit one needs 6+. */
export function isSearchableToken(token: string): boolean {
  const t = token.trim();
  if (t.length < 4 || !/\d/.test(t)) return false;
  return !/^\d+$/.test(t) || t.length >= 6;
}

/**
 * A case-insensitive (`~*`) whole-token pattern: no letter or digit either side, and not inside a
 * decimal amount (a digit and . or , before; . or , and a digit after). Postgres ARE syntax.
 */
export function tokenPattern(tokens: readonly string[]): string {
  const escaped = tokens.map((t) => t.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `(?<![A-Za-z0-9])(?<![0-9][.,])(?:${escaped.join('|')})(?![A-Za-z0-9])(?![.,][0-9])`;
}

/** +1 when the document's own VAT is a debit (bill, customer credit note), -1 when a credit. */
export function documentDirection(entityType: DocumentVatEntityType, noteType: string | null): 1 | -1 {
  if (entityType === 'supplier_invoice') return 1;
  if (entityType === 'customer_invoice') return -1;
  return noteType === 'customer' ? 1 : -1;
}

function isBaseLeg(r: JournalLineRow): boolean {
  if (r.is_vat === true) return false;
  const canonical = canonicalSubtype(r.account_subtype);
  if (canonical === 'payable' || canonical === 'receivable') return false;
  const cls = reportingClassFor(r.account_subtype);
  return cls !== 'vat' && cls !== 'bank';
}

/** Pure: the lines and totals from the journal rows (deduplicated by the strongest tie). */
export function summariseVatLines(rows: readonly JournalLineRow[], direction: 1 | -1) {
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
    const list = byJournal.get(r.journal_entry_id) ?? [];
    list.push(r);
    byJournal.set(r.journal_entry_id, list);
  }
  const vatByTie: Record<DocumentVatTie, number> = { posting: 0, reversal: 0, credit_note: 0, reference_match: 0, narration_match: 0 };
  let basePosted = 0;
  let baseNow = 0;
  const lines: DocumentVatLine[] = [];
  for (const [journalId, jl] of byJournal) {
    const head = tieOf.get(journalId)!;
    const signed = (r: JournalLineRow) => direction * (Number(r.debit) - Number(r.credit));
    const vatLines = jl.filter((r) => r.is_vat === true);
    const base = DERIVABLE_BASE.has(head.root_tie) ? r2(jl.filter(isBaseLeg).reduce((s, r) => s + signed(r), 0)) : null;
    if (base !== null) baseNow += base;
    if (base !== null && head.root_tie === 'posting') basePosted += base;
    for (const r of vatLines) {
      const vat = r2(signed(r));
      vatByTie[head.root_tie] += vat;
      lines.push({
        journal_entry_id: journalId, entry_number: head.entry_number, entry_date: fmtDate(head.entry_date),
        source: head.source, status: head.status, reversed: head.stands !== true, reverses_journal_id: head.reverses,
        tie: head.root_tie, tied_via: head.via, matched_in: head.matched_in,
        gl_account_id: String(r.gl_account_id), account_code: r.account_code, account_name: r.account_name,
        vat_type: r.vat_type, vat_amount: vat, net_base: vatLines.length === 1 ? base : null,
        description: r.line_description,
      });
    }
  }
  for (const k of Object.keys(vatByTie) as DocumentVatTie[]) vatByTie[k] = r2(vatByTie[k]);
  const vatPosted = vatByTie.posting;
  const vatNetNow = r2(Object.values(vatByTie).reduce((s, v) => s + v, 0));
  return {
    lines,
    totals: {
      vat_posted: vatPosted, vat_reversed: r2(vatPosted - vatNetNow), vat_net_now: vatNetNow, vat_by_tie: vatByTie,
      net_base_posted: r2(basePosted), net_base_now: r2(baseNow),
    },
  };
}

export async function getDocumentVatHistory(
  companyId: string, entityType: DocumentVatEntityType, entityId: string,
): Promise<DocumentVatHistory | null> {
  const doc = await readDocument(companyId, entityType, entityId);
  if (!doc) return null;
  const tied = await readTiedRoots(companyId, entityType, doc);
  const candidates = [...new Set([doc.number, doc.externalNumber].filter((t): t is string => Boolean(t && t.trim())).map((t) => t.trim()))];
  const tokens = candidates.filter(isSearchableToken);
  const matched = tokens.length > 0
    ? await readNarrationMatches(companyId, tokenPattern(tokens), tied.map((r) => r.journalId))
    : [];
  const truncated = matched.length > MATCH_LIMIT;
  const kept = matched.slice(0, MATCH_LIMIT);
  const roots: RootJournal[] = [...tied, ...kept.map(({ journalId, tie, matchedIn }) => ({ journalId, tie, via: null, matchedIn }))];
  const rows = await readChainLines(companyId, roots);
  const { lines, totals } = summariseVatLines(rows, documentDirection(entityType, doc.noteType));
  return {
    entity_type: entityType, entity_id: doc.id, document_number: doc.number,
    external_document_number: doc.externalNumber, document_status: doc.status, lines, totals,
    heuristic: {
      tokens, skipped_tokens: candidates.filter((t) => !tokens.includes(t)),
      journals_matched: kept.length, truncated, limit: MATCH_LIMIT, note: HEURISTIC_NOTE,
    },
  };
}
