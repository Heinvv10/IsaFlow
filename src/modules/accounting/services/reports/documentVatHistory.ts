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
 *   late_claim       its s16(3) late-claim companion (late_claim_of_id);
 *   reversal         a journal in the posting's (or companion's) reversal chain;
 *   credit_note      a LINKED credit note's journal, its companion and its
 *                    reversal chain (a cancelled note's contra);
 *   reference_match  HEURISTIC (documentVatHistoryQuery.readNarrationMatches:
 *   narration_match  any journal but an invoice / bill / note posting, on the
 *                    document's own VAT accounts, dated in or after its fiscal
 *                    period, naming its number as a whole token; each judged
 *                    on its own).
 * Credit applied by FIFO from a note NOT linked to the document carries no VAT
 * tie to it and is not read. A CANCELLED invoice or bill no longer names its
 * posting journal (the cancel nulls the link), so neither its posting nor its
 * reversal is tied: the reply says so in `notes`.
 *
 * Signs are in the DOCUMENT'S direction: positive = the way its own posting
 * moved VAT. Totals and the derivable / heuristic split: documentVatHistorySummary.
 */
import { fmtDate } from '@/lib/fmtDate';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import {
  MATCH_LIMIT, readChainLines, readDocument, readNarrationMatches, readPeriodStart, readTiedRoots,
  type DocumentVatEntityType, type RootJournal,
} from './documentVatHistoryQuery';
import {
  documentDirection, documentVatAccountIds, isSearchableToken, summariseVatLines, tokenPattern,
  type DocumentVatLine, type DocumentVatTotals, type HeuristicMatch,
} from './documentVatHistorySummary';

export { DOCUMENT_VAT_ENTITY_TYPES, type DocumentVatEntityType, type DocumentVatTie } from './documentVatHistoryQuery';
export type { DocumentVatLine, DocumentVatTotals, HeuristicMatch } from './documentVatHistorySummary';

export const HEURISTIC_NOTE =
  'reference_match and narration_match are HEURISTIC: a posted journal of any source that is not the posting of an '
  + 'invoice, bill or credit note (nor a reversal or late-claim companion), dated in or after this '
  + 'document\'s fiscal period, with a line on one of its own VAT accounts, whose reference or '
  + 'narration names one of its numbers as a whole token (case-insensitive; numbers shorter than 4 characters, longer '
  + 'than 64 or with no digit are not searched). Only its lines on this document\'s VAT accounts count; each match is '
  + 'judged on its own and can only reduce vat_net_now. A match may be about a different document, and a journal that adjusts this one '
  + 'without naming it is not found. Check each one before relying on it.';

export interface DocumentVatHistory {
  entity_type: DocumentVatEntityType;
  entity_id: string;
  document_number: string;
  external_document_number: string | null;
  document_status: string;
  lines: DocumentVatLine[];
  totals: DocumentVatTotals;
  heuristic: {
    /** False when no search ran: no searchable number, or the document has no VAT account to search on. */
    searched: boolean;
    tokens: string[]; skipped_tokens: string[]; journals_matched: number; truncated: boolean; limit: number; note: string;
    /** Each match with its chain's net VAT on the document's VAT accounts; judged one by one, never netted together. */
    matches: HeuristicMatch[];
    /** The earliest date searched: the start of the document's fiscal period (or its date). */
    from_date: string;
  };
  notes: string[];
}

const ROLE_KEYS = ['payable', 'vat_input', 'receivable', 'vat_output'] as const;

/** The system accounts 892 treats as AP / VAT roles; a role the company lacks is simply absent. */
async function roleAccountIds(companyId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const key of ROLE_KEYS) {
    try {
      ids.add((await getSystemAccountId(key, companyId)).toLowerCase());
    } catch (err) {
      if (!(err instanceof MissingSystemAccountError)) throw err;
    }
  }
  return ids;
}

export async function getDocumentVatHistory(
  companyId: string, entityType: DocumentVatEntityType, entityId: string,
): Promise<DocumentVatHistory | null> {
  const doc = await readDocument(companyId, entityType, entityId);
  if (!doc) return null;
  const tied = await readTiedRoots(companyId, entityType, doc);
  const tiedRows = await readChainLines(companyId, tied);
  const vatAccountIds = documentVatAccountIds(tiedRows);
  const postingDates = tiedRows.filter((r) => r.root_tie === 'posting')
    .map((r) => fmtDate(r.entry_date));
  const earliest = [doc.documentDate, ...postingDates].filter(Boolean).sort()[0] ?? doc.documentDate;
  // A same-period correction may be back-dated before the bill (review round 2, B4): search from its fiscal period.
  const fromDate = (await readPeriodStart(companyId, earliest)) ?? earliest;

  const candidates = [...new Set([doc.number, doc.externalNumber]
    .filter((t): t is string => Boolean(t && t.trim())).map((t) => t.trim()))];
  const tokens = candidates.filter(isSearchableToken);
  const searched = tokens.length > 0 && vatAccountIds.length > 0;
  const matched = searched
    ? await readNarrationMatches(companyId, tokenPattern(tokens), {
      vatAccountIds, fromDate, excludeJournalIds: [...new Set(tiedRows.map((r) => r.journal_entry_id))],
    })
    : [];
  const truncated = matched.length > MATCH_LIMIT;
  const kept: RootJournal[] = matched.slice(0, MATCH_LIMIT)
    .map(({ journalId, tie, matchedIn }) => ({ journalId, tie, via: null, matchedIn }));
  const rows = [...tiedRows, ...await readChainLines(companyId, kept)];
  const { lines, totals, matches } = summariseVatLines(rows, documentDirection(entityType, doc.noteType), await roleAccountIds(companyId));

  const notes: string[] = [];
  if (doc.status === 'cancelled' && !doc.postingJournalId && entityType !== 'credit_note') {
    notes.push('This document is cancelled. Cancelling clears its link to its posting journal, so neither that journal nor '
      + 'its reversal is tied here; find them with general_ledger or audit_trail.');
  }
  if (!searched) {
    notes.push(vatAccountIds.length === 0
      ? 'No heuristic search ran: the document has no posted VAT leg to search on.'
      : `No heuristic search ran: no number of this document is searchable (${candidates.join(', ') || 'none'}).`);
  }
  if (truncated) notes.push(`More than ${MATCH_LIMIT} journals matched; only the first ${MATCH_LIMIT} are counted.`);
  return {
    entity_type: entityType, entity_id: doc.id, document_number: doc.number,
    external_document_number: doc.externalNumber, document_status: doc.status, lines, totals,
    heuristic: {
      searched, tokens, skipped_tokens: candidates.filter((t) => !tokens.includes(t)),
      journals_matched: kept.length, truncated, limit: MATCH_LIMIT, note: HEURISTIC_NOTE, matches, from_date: fromDate,
    },
    notes,
  };
}
