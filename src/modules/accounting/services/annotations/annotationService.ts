/**
 * Internal row annotations on a statement.
 *
 * INTERNAL ONLY. Nothing in this module is reachable from a share link: the
 * share loader (sharedPackService.ts) never queries report_annotations, and the
 * public page's props type has no field an annotation could travel in. A note
 * is a working comment between colleagues, not a disclosure.
 *
 * Every statement carries `company_id`, including the resolve UPDATE, so an id
 * from another tenant matches zero rows and the route answers 404 rather than
 * mutating a row the caller may not see.
 */
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

export interface Annotation {
  id: string;
  rowId: string;
  periodStart: string;
  periodEnd: string;
  body: string;
  author: string;
  authorName: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** A note is a sentence or two about a figure, not a document. The cap is
 *  applied by truncation rather than rejection: a long paste should still
 *  land, and 4000 characters is far past any real note. */
export const MAX_BODY_CHARS = 4000;

/** One statement's rows, at most. The caller passes the row ids it rendered,
 *  so this is a bound on a single screen, not on the table. */
export const MAX_ROW_IDS = 500;

function toDateString(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
}

function toRow(r: DbRow): Annotation {
  return {
    id: String(r.id),
    rowId: String(r.row_id),
    periodStart: toDateString(r.period_start),
    periodEnd: toDateString(r.period_end),
    body: String(r.body),
    author: String(r.author),
    authorName: r.author_name === null || r.author_name === undefined ? null : String(r.author_name),
    createdAt: new Date(r.created_at).toISOString(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
  };
}

/** Annotations on the given rows for exactly this period. Resolved notes are
 *  returned too — the marker distinguishes them, and a thread that hides its
 *  own history is worse than one that shows it settled. */
export async function listAnnotations(
  companyId: string,
  rowIds: string[],
  periodStart: string,
  periodEnd: string,
): Promise<Annotation[]> {
  if (rowIds.length === 0) return [];
  const rows = (await sql`
    SELECT id, row_id, period_start, period_end, body, author, author_name, created_at, resolved_at
    FROM report_annotations
    WHERE company_id = ${companyId}::uuid
      AND row_id = ANY(${rowIds.slice(0, MAX_ROW_IDS)})
      AND period_start = ${periodStart}::date
      AND period_end = ${periodEnd}::date
    ORDER BY created_at ASC
  `) as DbRow[];
  return rows.map(toRow);
}

export async function createAnnotation(input: {
  companyId: string;
  userId: string;
  authorName: string | null;
  rowId: string;
  periodStart: string;
  periodEnd: string;
  body: string;
}): Promise<Annotation> {
  const rows = (await sql`
    INSERT INTO report_annotations (company_id, row_id, period_start, period_end, body, author, author_name)
    VALUES (
      ${input.companyId}::uuid, ${input.rowId},
      ${input.periodStart}::date, ${input.periodEnd}::date,
      ${input.body.slice(0, MAX_BODY_CHARS)}, ${input.userId}, ${input.authorName}
    )
    RETURNING id, row_id, period_start, period_end, body, author, author_name, created_at, resolved_at
  `) as DbRow[];
  const row = toRow(rows[0]!);
  log.info('Report annotation created', {
    companyId: input.companyId, userId: input.userId, annotationId: row.id,
    rowId: input.rowId, periodStart: input.periodStart, periodEnd: input.periodEnd,
  }, 'annotations');
  return row;
}

/** Returns false when the id is not this company's or is already resolved —
 *  the route answers 404, so a cross-company id and a missing id read the same
 *  to a caller probing for what exists. */
export async function resolveAnnotation(companyId: string, id: string, userId: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE report_annotations
    SET resolved_at = NOW(), resolved_by = ${userId}
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid AND resolved_at IS NULL
    RETURNING id
  `) as DbRow[];
  if (rows.length === 0) return false;
  log.info('Report annotation resolved', { companyId, userId, annotationId: id }, 'annotations');
  return true;
}
