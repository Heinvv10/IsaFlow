/**
 * Who authored a manual journal beyond its creator (R-035 PR6; Hein, rulings
 * through PR4 and PR5: whoever sets the amount is an author).
 *
 * A journal's authors are approval_document_authors (migration 869): its
 * created_by — the person who composed it, the importer, the uploader, the
 * runner — plus gl_journal_entries.content_authors, which only two things
 * write, and only while manual_journal enforcement is on (so with it off no
 * statement here names an 869 column of the journal):
 *
 *   - a recurring run unions in its TEMPLATE's authors at mint (the journal
 *     keeps no link to its template, as PR4 found for invoices): the
 *     template's creator and every user whose edit changed what it posts —
 *     recurring_journals.content_authors (869, stamped by the
 *     recurring-journals PUT) or recurring_transaction_templates.content_authors
 *     (865, stamped by the template update);
 *   - the account merge, the one path that edits a DRAFT journal's content
 *     (it re-points the draft's lines: Q10 stales the approval), stamps the
 *     merging user on every draft whose lines it moved.
 */
import { sql } from '@/lib/neon';
import { isEnforced } from './approvalEnforcement';

export type JournalTemplate =
  | { kind: 'recurring_journal'; id: string }
  | { kind: 'recurring_transaction_template'; id: string };

type Row = Record<string, unknown>;

/**
 * The template's authors, company-scoped and de-duplicated: its creator and
 * its stamped editors. recurring_transaction_templates.created_by is VARCHAR,
 * cast only when it is a canonical uuid. Reads an 869 column for a recurring
 * journal: call it only under enforcement.
 */
export async function templateAuthors(companyId: string, template: JournalTemplate): Promise<string[]> {
  let rows: Row[];
  switch (template.kind) {
    case 'recurring_journal':
      rows = (await sql`
        SELECT a::TEXT AS author FROM recurring_journals rj,
          unnest(rj.content_authors || ARRAY[rj.created_by]) a
        WHERE rj.id = ${template.id}::UUID AND rj.company_id = ${companyId}::UUID
      `) as Row[];
      break;
    case 'recurring_transaction_template':
      rows = (await sql`
        SELECT a::TEXT AS author FROM recurring_transaction_templates t,
          unnest(t.content_authors || ARRAY[CASE WHEN t.created_by
            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t.created_by::UUID END]) a
        WHERE t.id = ${template.id}::UUID AND t.company_id = ${companyId}::UUID
      `) as Row[];
      break;
  }
  return [...new Set(rows.map((r) => r.author).filter((a): a is string => typeof a === 'string'))];
}

/**
 * The account merge moved `movedLineIds`: under manual_journal enforcement,
 * every DRAFT journal owning one gains `editedBy` as an author — the merge
 * changed what it would post, so whoever ran it may not approve it. Posted
 * journals are not documents awaiting approval. No editor (a system merge)
 * stamps nobody.
 */
export async function stampMergedDraftJournals(companyId: string, movedLineIds: readonly string[],
  editedBy: string | undefined): Promise<void> {
  if (!editedBy || movedLineIds.length === 0) return;
  if (!(await isEnforced(companyId, 'manual_journal'))) return;
  await sql`
    UPDATE gl_journal_entries je
    SET content_authors = approval_add_author(je.content_authors, ${editedBy}::UUID)
    WHERE je.company_id = ${companyId}::UUID AND je.status = 'draft'
      AND je.id IN (SELECT jl.journal_entry_id FROM gl_journal_lines jl
                    WHERE jl.company_id = ${companyId}::UUID AND jl.id = ANY(${[...movedLineIds]}::UUID[]))
  `;
}
