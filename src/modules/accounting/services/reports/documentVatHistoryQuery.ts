/**
 * The reads behind `getDocumentVatHistory` (documentVatHistory.ts): which
 * journals a document is tied to, and every line of those journals.
 *
 *  1. the document row (number(s), date, status, posting journal);
 *  2. the DERIVABLE roots: its own posting (`gl_journal_entry_id`, plus any
 *     journal sourced from it via `source_record_id` — DRC VAT) and the posting
 *     journals of the credit notes LINKED to it;
 *  3. every root's CHAIN: posted reversals (`reversal_of_id`) and s16(3)
 *     late-claim companions (`late_claim_of_id`, vat201Service's tie), cycle-
 *     guarded, with every line and the VAT201 member-line rule evaluated per
 *     line — plus the late-claim clearing leg, which holds the VAT a locked
 *     period moved off VAT Input until its companion claims it;
 *  4. the HEURISTIC roots (review rounds 1-3): posted journals dated on or after
 *     the start of the document's fiscal period (a same-period correction may be
 *     back-dated before it), of ANY source, that are not the posting journal of
 *     a supplier invoice, customer invoice or credit note (their reversals and
 *     companions are never roots either), that carry a line on one of the
 *     document's OWN VAT accounts, and whose reference / narration / a line
 *     narration names one of its numbers as a whole token. MATCH_LIMIT + 1 at
 *     most. Every filter but the regex runs first; the regex reads only the
 *     survivors and their lines. No source is trusted (round 3): a supplier
 *     refund allocated from the bank posts as auto_supplier_payment. Another
 *     document's own posting that names the number (an expense claim, a bank
 *     allocation, a provisional) therefore matches too and makes mirror_bill
 *     refuse — fail-safe; the refusal names the journal and its source.
 *
 * Only POSTED journals are read, as the VAT201 reads them. The VAT submission
 * clearing journal and the year-end closing journal are excluded through their
 * shared markers. A posted journal dated in the future counts (it is in the
 * ledger and will reach the return for its period).
 */
import { sql, type DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { MAX_CHAIN_DEPTH } from '../shared/journalChainHead';
import { journalStandsFragment } from '../shared/journalInForceAsAt';
import { YEAR_END_JOURNAL_SOURCE } from '../gl/yearEndJournalSource';
import { LATE_CLAIM_CLEARING_SUBTYPE } from '../gl/accountSubtypeVocabulary';
import { vatEntryMemberLineSql, vatEntrySourceAdmitsSql } from './vatEntryMembership';

export const DOCUMENT_VAT_ENTITY_TYPES = ['supplier_invoice', 'customer_invoice', 'credit_note'] as const;
export type DocumentVatEntityType = (typeof DOCUMENT_VAT_ENTITY_TYPES)[number];
export type DocumentVatTie = 'posting' | 'late_claim' | 'reversal' | 'credit_note' | 'narration_match' | 'reference_match';

/** Most heuristic matches read per call; one more is fetched to say the list was cut. */
export const MATCH_LIMIT = 100;
export { LATE_CLAIM_CLEARING_SUBTYPE };

export interface DocumentRow {
  id: string;
  number: string;
  externalNumber: string | null;
  postingJournalId: string | null;
  status: string;
  /** invoice_date / credit_date, YYYY-MM-DD. */
  documentDate: string;
  /** credit_note only: 'customer' | 'supplier'. */
  noteType: string | null;
}

export interface RootJournal {
  journalId: string;
  tie: DocumentVatTie;
  /** The credit note number for a credit_note tie, else null. */
  via: string | null;
  /** Heuristic ties only: where the token was found. */
  matchedIn: string | null;
}

export interface JournalLineRow {
  journal_entry_id: string;
  /** The root journal of this row's chain (itself for a root). */
  root_journal_id: string;
  /**
   * When the journal entered the ledger: the later of its created_at and posted_at (a draft written before a note
   * and posted after it counts from its posting — review round 3). An approval compares it with the note's own.
   */
  written_at: Date | string;
  root_tie: DocumentVatTie;
  via: string | null;
  matched_in: string | null;
  reverses: string | null;
  entry_number: string | null;
  entry_date: Date | string;
  source: string | null;
  status: string;
  stands: boolean;
  line_id: string;
  gl_account_id: string;
  account_code: string | null;
  account_name: string | null;
  account_subtype: string | null;
  vat_type: string | null;
  debit: number | string;
  credit: number | string;
  line_description: string | null;
  is_vat: boolean;
}

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

export async function readDocument(
  companyId: string, entityType: DocumentVatEntityType, entityId: string,
): Promise<DocumentRow | null> {
  const rows = entityType === 'supplier_invoice'
    ? (await sql`
        SELECT id, invoice_number AS number, external_document_number, gl_journal_entry_id, status, invoice_date AS doc_date,
          NULL AS note_type
        FROM supplier_invoices WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[]
    : entityType === 'customer_invoice'
      ? (await sql`
          SELECT id, invoice_number AS number, external_document_number, gl_journal_entry_id, status, invoice_date AS doc_date,
            NULL AS note_type
          FROM customer_invoices WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[]
      : (await sql`
          SELECT id, credit_note_number AS number, external_document_number, gl_journal_entry_id, status, credit_date AS doc_date,
            type AS note_type
          FROM credit_notes WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), number: String(r.number ?? ''), externalNumber: str(r.external_document_number),
    postingJournalId: str(r.gl_journal_entry_id), status: String(r.status ?? ''), documentDate: fmtDate(r.doc_date),
    noteType: str(r.note_type),
  };
}

/** The start of the fiscal period holding `date` (this company's), or null when none does. */
export async function readPeriodStart(companyId: string, date: string): Promise<string | null> {
  const rows = (await sql`
    SELECT start_date FROM fiscal_periods
    WHERE company_id = ${companyId}::UUID AND start_date <= ${date}::DATE AND end_date >= ${date}::DATE
    ORDER BY start_date DESC LIMIT 1`) as DbRow[];
  return rows[0] ? fmtDate(rows[0].start_date) : null;
}

/** The document's own posting journals and the posting journals of the credit notes linked to it. */
export async function readTiedRoots(
  companyId: string, entityType: DocumentVatEntityType, doc: DocumentRow,
): Promise<RootJournal[]> {
  const roots: RootJournal[] = [];
  if (doc.postingJournalId) roots.push({ journalId: doc.postingJournalId, tie: 'posting', via: null, matchedIn: null });
  const sourced = (await sql`
    SELECT je.id FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID AND je.source_record_id = ${doc.id}::UUID AND je.status = 'posted'
    ORDER BY je.entry_date, je.id`) as DbRow[];
  for (const r of sourced) roots.push({ journalId: String(r.id), tie: 'posting', via: null, matchedIn: null });
  if (entityType === 'credit_note') return roots;
  const notes = entityType === 'supplier_invoice'
    ? (await sql`
        SELECT cn.gl_journal_entry_id, cn.credit_note_number FROM credit_notes cn
        WHERE cn.company_id = ${companyId}::UUID AND cn.supplier_invoice_id = ${doc.id}::UUID
          AND cn.type = 'supplier' AND cn.gl_journal_entry_id IS NOT NULL
        ORDER BY cn.credit_date, cn.id`) as DbRow[]
    : (await sql`
        SELECT cn.gl_journal_entry_id, cn.credit_note_number FROM credit_notes cn
        WHERE cn.company_id = ${companyId}::UUID AND cn.customer_invoice_id = ${doc.id}::UUID
          AND cn.type = 'customer' AND cn.gl_journal_entry_id IS NOT NULL
        ORDER BY cn.credit_date, cn.id`) as DbRow[];
  for (const r of notes) {
    roots.push({ journalId: String(r.gl_journal_entry_id), tie: 'credit_note', via: str(r.credit_note_number), matchedIn: null });
  }
  return roots;
}

/**
 * Hand journals naming the document (see the header, step 4). `vatAccountIds` are the accounts the document's own
 * VAT legs sit on; `fromDate` the earlier of its date and its posting's.
 */
export async function readNarrationMatches(
  companyId: string, pattern: string, scope: { vatAccountIds: readonly string[]; fromDate: string; excludeJournalIds: readonly string[] },
): Promise<(RootJournal & { entryNumber: string | null })[]> {
  if (scope.vatAccountIds.length === 0) return [];
  // Driven from the HAND journals dated on or after the document (company + date index), each probed for a line on the
  // document's VAT accounts (company + journal index); the regexes then read only those journals and their lines.
  const rows = (await sql`
    WITH cand AS MATERIALIZED (
      SELECT je.id, je.entry_number, je.entry_date, je.reference, je.description
      FROM gl_journal_entries je
      WHERE je.company_id = ${companyId}::UUID AND je.status = 'posted' AND je.entry_date >= ${scope.fromDate}::DATE
        AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND ${vatEntrySourceAdmitsSql(sql`je.source`)}
        AND je.reversal_of_id IS NULL AND je.late_claim_of_id IS NULL
        AND NOT (je.id = ANY(${scope.excludeJournalIds as string[]}::UUID[]))
        -- OFFSET 0 keeps each probe a per-journal index lookup (company_id, journal_entry_id), never a scan
        -- of the company's lines; the NOT IN lists are each read once and hashed (they hold no NULLs).
        AND EXISTS (SELECT 1 FROM gl_journal_lines jl
                    WHERE jl.company_id = ${companyId}::UUID AND jl.journal_entry_id = je.id
                      AND jl.gl_account_id = ANY(${scope.vatAccountIds as string[]}::UUID[]) OFFSET 0)
        AND je.id NOT IN (SELECT d.gl_journal_entry_id FROM supplier_invoices d
                          WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id IS NOT NULL)
        AND je.id NOT IN (SELECT d.gl_journal_entry_id FROM customer_invoices d
                          WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id IS NOT NULL)
        AND je.id NOT IN (SELECT d.gl_journal_entry_id FROM credit_notes d
                          WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id IS NOT NULL)
    ),
    line_hits AS MATERIALIZED (
      SELECT c.id FROM cand c
      WHERE EXISTS (SELECT 1 FROM gl_journal_lines l
                    WHERE l.company_id = ${companyId}::UUID AND l.journal_entry_id = c.id AND l.description ~* ${pattern} OFFSET 0)
    )
    SELECT c.id, c.entry_number,
      COALESCE(c.reference ~* ${pattern}, FALSE) AS in_reference,
      COALESCE(c.description ~* ${pattern}, FALSE) AS in_description,
      (c.id IN (SELECT id FROM line_hits)) AS in_line
    FROM cand c
    WHERE c.reference ~* ${pattern} OR c.description ~* ${pattern} OR c.id IN (SELECT id FROM line_hits)
    ORDER BY c.entry_date, c.entry_number, c.id
    LIMIT ${MATCH_LIMIT + 1}`) as DbRow[];
  return rows.map((r) => {
    const inReference = r.in_reference === true;
    const where = [inReference ? 'reference' : null, r.in_description === true ? 'narration' : null,
      r.in_line === true ? 'line_narration' : null].filter(Boolean).join(',');
    return {
      journalId: String(r.id), entryNumber: str(r.entry_number),
      tie: inReference ? 'reference_match' as const : 'narration_match' as const, via: null, matchedIn: where,
    };
  });
}

/**
 * Every line of every root journal and of every posted journal in its chain. A reversal of the document's own
 * posting (or of its late-claim companion) is 'reversal'; the companion of the posting is 'late_claim'; every
 * other chain member inherits its root's tie.
 */
export async function readChainLines(companyId: string, roots: readonly RootJournal[]): Promise<JournalLineRow[]> {
  if (roots.length === 0) return [];
  const notClearing = vatEntrySourceAdmitsSql(sql`je.source`);
  const rows = (await sql`
    WITH RECURSIVE roots AS (
      SELECT * FROM unnest(
        ${roots.map((r) => r.journalId)}::UUID[], ${roots.map((r) => r.tie)}::TEXT[],
        ${roots.map((r) => r.via)}::TEXT[], ${roots.map((r) => r.matchedIn)}::TEXT[]
      ) AS r(id, tie, via, matched_in)
    ),
    chain AS (
      SELECT r.id, r.id AS root, r.tie, r.via, r.matched_in, NULL::UUID AS reverses, ARRAY[r.id] AS path FROM roots r
      UNION ALL
      SELECT j.id, c.root,
        CASE WHEN j.late_claim_of_id = c.id AND c.tie = 'posting' THEN 'late_claim'
             WHEN j.reversal_of_id = c.id AND c.tie IN ('posting', 'late_claim') THEN 'reversal'
             ELSE c.tie END,
        c.via, c.matched_in, CASE WHEN j.reversal_of_id = c.id THEN c.id END, c.path || j.id
      FROM gl_journal_entries j JOIN chain c ON (j.reversal_of_id = c.id OR j.late_claim_of_id = c.id)
      WHERE j.company_id = ${companyId}::UUID AND j.status = 'posted'
        AND j.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND NOT j.id = ANY(c.path) AND cardinality(c.path) < ${MAX_CHAIN_DEPTH}
    )
    SELECT ch.id AS journal_entry_id, ch.root AS root_journal_id, ch.tie AS root_tie, ch.via, ch.matched_in, ch.reverses,
      je.entry_number, je.entry_date, GREATEST(je.created_at, COALESCE(je.posted_at, je.created_at)) AS written_at, je.source, je.status,
      ${journalStandsFragment('je.id', companyId)} AS stands,
      jl.id AS line_id, jl.gl_account_id, ga.account_code, ga.account_name, ga.account_subtype,
      jl.vat_type, jl.debit, jl.credit, jl.description AS line_description,
      (${vatEntryMemberLineSql()} OR ga.account_subtype = ${LATE_CLAIM_CLEARING_SUBTYPE}) AS is_vat
    FROM chain ch
    JOIN gl_journal_entries je ON je.id = ch.id AND je.company_id = ${companyId}::UUID AND je.status = 'posted'
      AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE} AND ${notClearing}
    JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
    ORDER BY je.entry_date, je.entry_number, je.id, jl.created_at, jl.id`) as JournalLineRow[];
  return rows;
}
