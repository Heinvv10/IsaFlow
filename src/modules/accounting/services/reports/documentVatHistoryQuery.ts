/**
 * The reads behind `getDocumentVatHistory` (documentVatHistory.ts): which
 * journals a document is tied to, and every line of those journals.
 *
 * Three reads, all scoped by company:
 *  1. the document row (its number(s) and its posting journal);
 *  2. the ROOT journals: its own posting (`gl_journal_entry_id`, plus any
 *     journal sourced from it via `source_record_id` — DRC VAT), the posting
 *     journals of the credit notes LINKED to it, and — the heuristic — posted
 *     VAT-bearing journals whose reference, narration or a line narration
 *     names one of its numbers as a whole token, bounded to MATCH_LIMIT;
 *  3. every root's reversal CHAIN (reversal_of_id, posted, cycle-guarded) and
 *     every line of every journal reached, with the VAT201 member-line rule
 *     (`vatEntryMemberLineSql`) evaluated per line, so "a VAT line" means here
 *     exactly what it means on the return.
 *
 * Only POSTED journals are read, as the VAT201 reads them; a legacy
 * `status = 'reversed'` header is not posted and is left out the same way. The
 * VAT submission clearing journal and the year-end closing journal are never a
 * document's VAT and are excluded through their shared markers.
 */
import { sql, type DbRow } from '@/lib/neon';
import { MAX_CHAIN_DEPTH } from '../shared/journalChainHead';
import { journalStandsFragment } from '../shared/journalInForceAsAt';
import { YEAR_END_JOURNAL_SOURCE } from '../gl/yearEndJournalSource';
import { vatEntryMemberLineSql, vatEntrySourceAdmitsSql } from './vatEntryMembership';

export const DOCUMENT_VAT_ENTITY_TYPES = ['supplier_invoice', 'customer_invoice', 'credit_note'] as const;
export type DocumentVatEntityType = (typeof DOCUMENT_VAT_ENTITY_TYPES)[number];
export type DocumentVatTie = 'posting' | 'reversal' | 'credit_note' | 'narration_match' | 'reference_match';

/** Most heuristic matches read per call; one more is fetched to say the list was cut. */
export const MATCH_LIMIT = 100;

export interface DocumentRow {
  id: string;
  number: string;
  externalNumber: string | null;
  postingJournalId: string | null;
  status: string;
  /** credit_note only: 'customer' | 'supplier'. */
  noteType: string | null;
}

export interface RootJournal {
  journalId: string;
  tie: DocumentVatTie;
  /** The credit note number for a credit_note tie, the matched token for a heuristic one, else null. */
  via: string | null;
  /** Heuristic ties only: where the token was found. */
  matchedIn: string | null;
}

export interface JournalLineRow {
  journal_entry_id: string;
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
        SELECT id, invoice_number AS number, external_document_number, gl_journal_entry_id, status, NULL AS note_type
        FROM supplier_invoices WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[]
    : entityType === 'customer_invoice'
      ? (await sql`
          SELECT id, invoice_number AS number, external_document_number, gl_journal_entry_id, status, NULL AS note_type
          FROM customer_invoices WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[]
      : (await sql`
          SELECT id, credit_note_number AS number, external_document_number, gl_journal_entry_id, status, type AS note_type
          FROM credit_notes WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), number: String(r.number ?? ''), externalNumber: str(r.external_document_number),
    postingJournalId: str(r.gl_journal_entry_id), status: String(r.status ?? ''), noteType: str(r.note_type),
  };
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
 * Posted VAT-bearing journals, not already tied, whose reference / narration / line narration matches
 * `pattern` (a case-insensitive whole-token regex built by documentVatHistory.tokenPattern). Ordered by
 * date and number; MATCH_LIMIT + 1 rows at most.
 */
export async function readNarrationMatches(
  companyId: string, pattern: string, excludeJournalIds: readonly string[],
): Promise<(RootJournal & { entryNumber: string | null })[]> {
  const rows = (await sql`
    WITH line_hits AS (
      SELECT DISTINCT jl.journal_entry_id AS id
      FROM gl_journal_lines jl
      WHERE jl.company_id = ${companyId}::UUID AND jl.description ~* ${pattern}
    )
    SELECT je.id, je.entry_number,
      COALESCE(je.reference ~* ${pattern}, FALSE) AS in_reference,
      COALESCE(je.description ~* ${pattern}, FALSE) AS in_description,
      (je.id IN (SELECT id FROM line_hits)) AS in_line
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID AND je.status = 'posted'
      AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
      AND ${vatEntrySourceAdmitsSql(sql`je.source`)}
      AND NOT (je.id = ANY(${excludeJournalIds as string[]}::UUID[]))
      AND (je.reference ~* ${pattern} OR je.description ~* ${pattern} OR je.id IN (SELECT id FROM line_hits))
      AND EXISTS (
        SELECT 1 FROM gl_journal_lines jl
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
        WHERE jl.company_id = ${companyId}::UUID AND jl.journal_entry_id = je.id AND ${vatEntryMemberLineSql()}
      )
    ORDER BY je.entry_date, je.entry_number, je.id
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
 * Every line of every root journal and of every posted journal in a root's reversal chain. A chain
 * member inherits its root's tie — except a reversal of the document's own posting, which is
 * 'reversal' — and names the journal it reverses.
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
      SELECT r.id, r.tie, r.via, r.matched_in, NULL::UUID AS reverses, ARRAY[r.id] AS path FROM roots r
      UNION ALL
      SELECT j.id, CASE WHEN c.tie = 'posting' THEN 'reversal' ELSE c.tie END, c.via, c.matched_in, c.id, c.path || j.id
      FROM gl_journal_entries j JOIN chain c ON j.reversal_of_id = c.id
      WHERE j.company_id = ${companyId}::UUID AND j.status = 'posted'
        AND j.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND NOT j.id = ANY(c.path) AND cardinality(c.path) < ${MAX_CHAIN_DEPTH}
    )
    SELECT ch.id AS journal_entry_id, ch.tie AS root_tie, ch.via, ch.matched_in, ch.reverses,
      je.entry_number, je.entry_date, je.source, je.status,
      ${journalStandsFragment('je.id', companyId)} AS stands,
      jl.id AS line_id, jl.gl_account_id, ga.account_code, ga.account_name, ga.account_subtype,
      jl.vat_type, jl.debit, jl.credit, jl.description AS line_description,
      ${vatEntryMemberLineSql()} AS is_vat
    FROM chain ch
    JOIN gl_journal_entries je ON je.id = ch.id AND je.company_id = ${companyId}::UUID AND je.status = 'posted'
      AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE} AND ${notClearing}
    JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = ${companyId}::UUID
    ORDER BY je.entry_date, je.entry_number, je.id, jl.created_at, jl.id`) as JournalLineRow[];
  return rows;
}
