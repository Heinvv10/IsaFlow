/**
 * The captured documents the provisional evidence attach would accept, for its picker
 * (GET /api/accounting/document-capture?attachable=1).
 *
 * The list is what the attach accepts, NARROWED ON PURPOSE to supplier evidence. It mirrors what the attach itself
 * checks, so it offers nothing the attach then refuses:
 *  - claimCapturedDocumentForPosting: not posted, not rejected, read finished, and (spend 'evidence' ->
 *    findPostedContent) the same FILE (raw_bytes_sha256) not already posted from another document;
 *  - assertDocumentNotAlreadyPosted: not the source_document_id of a posted journal that still stands, and not
 *    the target of an active gl_journal_document_links row.
 * The narrowing hides what the attach would itself accept but is not evidence for a supplier spend: our own sent
 * invoices, sent emails and dunning letters, and bank or supplier statements (a statement may have no document_type;
 * the bank import or supplier reconciliation that points at it identifies it).
 *
 * Paging is offset for the first call and KEYSET (`after`) for "Load more": the next page is the rows strictly older
 * than the last one seen by (created_at, id), so a document attached or posted elsewhere between two loads cannot
 * shift a row out of the next page. `total` is always the full count under the predicate. The cursor carries the
 * created_at at full microsecond precision (a JS Date would cut it to milliseconds and skip rows).
 * created_at is nullable in the schema (always DEFAULT NOW() in practice); a NULL one is left out, since it would sort
 * first under DESC and yield a cursor that cannot be parsed.
 *
 * ONE statement carries the predicate once: a CTE `attachable` holds the qualifying rows, `page_rows` takes the page
 * from it, and the total is counted from the same CTE, so the list and its total cannot disagree. The page is joined
 * to the count with a LEFT JOIN, so `total` is right even when the page is empty (one row with a NULL id comes back,
 * and is dropped). Rows keep their native column types, exactly as `SELECT *` returned them. (No nested `sql`
 * fragment for the predicate: it breaks the unit suites that mock `sql`, see shared/journalInForceAsAt.ts.)
 * `nextAfter` is null on a page shorter than `pageSize`: nothing follows it.
 */
import { sql } from '@/lib/neon';
import { journalStandsFragment } from '../shared/journalInForceAsAt';

const CURSOR_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z,([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface AttachableCursor { createdAt: string; id: string }

/** `<created_at as YYYY-MM-DDTHH:MM:SS.uuuuuuZ>,<uuid>`, or null when it is not a real instant and a uuid. */
export function parseAttachableCursor(raw: string): AttachableCursor | null {
  const m = CURSOR_RE.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  // A date that rolls over (31 February, hour 24, second 60) is not an instant Postgres would accept.
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d
    || t.getUTCHours() !== h || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== sec) return null;
  return { createdAt: raw.slice(0, raw.indexOf(',')), id: m[8]!.toLowerCase() };
}

export async function listAttachableDocuments(
  companyId: string,
  opts: { page?: number; pageSize: number; after?: AttachableCursor },
): Promise<{ rows: Record<string, unknown>[]; total: number; nextAfter: string | null }> {
  const { pageSize } = opts;
  const offset = opts.after ? 0 : ((opts.page ?? 1) - 1) * pageSize;
  const afterTs = opts.after?.createdAt ?? null;
  const afterId = opts.after?.id ?? null;

  const result = await sql`
    WITH attachable AS (
      SELECT cd.*, to_char(cd.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
      FROM captured_documents cd
      WHERE cd.company_id = ${companyId} AND cd.created_at IS NOT NULL AND cd.posted_at IS NULL AND cd.status <> 'rejected' AND cd.read_state = 'done'
        AND cd.document_type IS DISTINCT FROM 'sent_invoice' AND cd.document_type IS DISTINCT FROM 'outbound_email'
        AND cd.document_type IS DISTINCT FROM 'dunning' AND cd.document_type IS DISTINCT FROM 'statement'
        AND NOT EXISTS (SELECT 1 FROM bank_statement_imports b WHERE b.source_document_id = cd.id AND b.company_id = cd.company_id)
        AND NOT EXISTS (SELECT 1 FROM supplier_statement_reconciliations r
                        WHERE r.source_document_id = cd.id AND r.company_id = cd.company_id)
        AND NOT EXISTS (SELECT 1 FROM captured_documents p
                        WHERE p.company_id = cd.company_id AND p.id <> cd.id AND p.posted_at IS NOT NULL
                          AND cd.raw_bytes_sha256 IS NOT NULL AND p.raw_bytes_sha256 = cd.raw_bytes_sha256)
        AND NOT EXISTS (SELECT 1 FROM gl_journal_entries je
                        WHERE je.company_id = cd.company_id AND je.source_document_id = cd.id AND je.status = 'posted'
                          AND ${journalStandsFragment('je.id', companyId)})
        AND NOT EXISTS (SELECT 1 FROM gl_journal_document_links l
                        WHERE l.company_id = cd.company_id AND l.captured_document_id = cd.id AND l.unlinked_at IS NULL)
    ),
    page_rows AS (
      SELECT * FROM attachable a
      WHERE (${afterTs}::timestamptz IS NULL OR (a.created_at, a.id) < (${afterTs}::timestamptz, ${afterId}::uuid))
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    )
    SELECT pr.*, t.total
    FROM (SELECT COUNT(*)::int AS total FROM attachable) t
    LEFT JOIN page_rows pr ON true
    ORDER BY pr.created_at DESC, pr.id DESC
  ` as Record<string, unknown>[];

  const total = (result[0]?.total as number) || 0;
  const rows = result.filter((r) => r.id !== null);
  const last = rows[rows.length - 1];
  return {
    rows,
    total,
    nextAfter: last && rows.length >= pageSize ? `${String(last.cursor_ts)},${String(last.id)}` : null,
  };
}
