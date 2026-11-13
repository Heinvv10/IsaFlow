/**
 * Comments on invoices, bills and bank lines (migration 986 record_comments; master plan wave 5, M14).
 *
 * Every function names the company. A write judges everything before its first write (a 4xx commits what
 * was written): Login-as, the record, the text, the mentioned people, then the INSERT or UPDATE. The table
 * holds the rest (author-only edits, deleted is final, author and stamps are the session's and the clock's).
 * Mentions notify in-app only (user_notifications, kind comment_mention) through notifyUsers: no email.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { notifyUsers } from '@/modules/accounting/services/notifications/userNotificationService';
import { findCommentRecord, type CommentRecordType } from './commentRecords';
import { CommentError, MAX_COMMENTS_PER_RECORD, cleanCommentBody, cleanMentions, mentionSnippet } from './commentText';

export interface RecordComment {
  id: string;
  recordType: CommentRecordType;
  recordId: string;
  body: string;
  authorId: string;
  authorName: string | null;
  mentions: string[];
  createdAt: string;
  editedAt: string | null;
}

export interface Mentionable { id: string; name: string }

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function toComment(r: DbRow): RecordComment {
  return {
    id: String(r.id),
    recordType: String(r.record_type) as CommentRecordType,
    recordId: String(r.record_id),
    body: String(r.body),
    authorId: String(r.author_id),
    authorName: r.author_name == null ? null : String(r.author_name),
    mentions: (r.mentions as string[] | null) ?? [],
    createdAt: iso(r.created_at) ?? '',
    editedAt: iso(r.edited_at),
  };
}

const SELECT_ONE = (companyId: string, id: string) => sql`
  SELECT c.id::TEXT AS id, c.record_type, c.record_id::TEXT AS record_id, c.body, c.author_id, c.mentions,
         c.created_at, c.edited_at, c.deleted_at,
         public.approval_company_member_name(c.company_id, c.author_id) AS author_name
    FROM record_comments c WHERE c.company_id = ${companyId}::UUID AND c.id = ${id}::UUID`;

/**
 * The record's live comments, oldest first, and the colleagues a comment can mention: only for a caller who can
 * comment (`canComment`); a read-only role gets an empty list, not the company's roster.
 */
export async function listComments(companyId: string, userId: string, type: CommentRecordType, recordId: string, canComment: boolean):
Promise<{ comments: RecordComment[]; mentionable: Mentionable[]; olderHidden: number }> {
  if (!(await findCommentRecord(companyId, type, recordId))) throw new CommentError(404, 'Record not found');
  // The newest MAX_COMMENTS_PER_RECORD, shown oldest first; `olderHidden` counts any beyond that.
  const rows = (await sql`
    SELECT * FROM (
      SELECT c.id::TEXT AS id, c.record_type, c.record_id::TEXT AS record_id, c.body, c.author_id, c.mentions,
             c.created_at, c.edited_at,
             public.approval_company_member_name(c.company_id, c.author_id) AS author_name
        FROM record_comments c
       WHERE c.company_id = ${companyId}::UUID AND c.record_type = ${type} AND c.record_id = ${recordId}::UUID
         AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ${MAX_COMMENTS_PER_RECORD}) newest
    ORDER BY created_at, id`) as DbRow[];
  const total = await liveCount(companyId, type, recordId);
  const people = !canComment ? [] : (await sql`
    SELECT m.user_id AS id, public.approval_company_member_name(${companyId}::UUID, m.user_id) AS name
      FROM public.approval_company_other_members(${companyId}::UUID, ${userId}) m
     WHERE m.is_active IS NOT FALSE AND m.status IS DISTINCT FROM 'suspended' AND m.suspended_at IS NULL
     ORDER BY 2`) as DbRow[];
  return {
    comments: rows.map(toComment),
    olderHidden: Math.max(0, total - rows.length),
    mentionable: people.map((p) => ({ id: String(p.id), name: String(p.name ?? p.id) })),
  };
}

async function liveCount(companyId: string, type: CommentRecordType, recordId: string): Promise<number> {
  const r = (await sql`SELECT count(*)::INT AS n FROM record_comments
                        WHERE company_id = ${companyId}::UUID AND record_type = ${type} AND record_id = ${recordId}::UUID
                          AND deleted_at IS NULL`) as DbRow[];
  return Number(r[0]?.n ?? 0);
}

/** Members among `ids`, as the table's recipient rule sees them. A non-member is a 400, before any write. */
async function assertMembers(companyId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const bad = (await sql`
    SELECT u FROM unnest(${[...ids]}::TEXT[]) AS u
     WHERE NOT public.user_notification_recipient_ok(${companyId}::UUID, u)`) as DbRow[];
  if (bad.length > 0) throw new CommentError(400, 'You can mention only members of this company');
}

async function notifyMentions(
  companyId: string, c: RecordComment, label: string, href: string, newlyMentioned: readonly string[],
): Promise<void> {
  if (newlyMentioned.length === 0) return;
  const who = c.authorName ?? 'A colleague';
  await notifyUsers(companyId, newlyMentioned, {
    kind: 'comment_mention', refId: c.recordId, title: `${who} mentioned you on ${label}`,
    body: mentionSnippet(c.body), href, dedupeKey: `comment:${c.id}`,
  });
}

export async function createComment(
  companyId: string, userId: string, type: CommentRecordType, recordId: string, rawBody: unknown, rawMentions?: readonly string[],
): Promise<RecordComment> {
  await assertNotImpersonating(); // first, before any read or write
  const record = await findCommentRecord(companyId, type, recordId);
  if (!record) throw new CommentError(404, 'Record not found');
  const body = cleanCommentBody(rawBody);
  const mentions = cleanMentions(rawMentions, userId);
  await assertMembers(companyId, mentions);
  if ((await liveCount(companyId, type, recordId)) >= MAX_COMMENTS_PER_RECORD) {
    throw new CommentError(400, `This record already has ${MAX_COMMENTS_PER_RECORD} comments, the most it can hold. Delete one to add another.`);
  }
  const ins = (await sql`
    INSERT INTO record_comments (company_id, record_type, record_id, body, mentions)
    VALUES (${companyId}::UUID, ${type}, ${recordId}::UUID, ${body}, ${mentions}::TEXT[])
    RETURNING id::TEXT AS id`) as DbRow[];
  const comment = toComment(((await SELECT_ONE(companyId, String(ins[0]?.id))) as DbRow[])[0] as DbRow);
  await notifyMentions(companyId, comment, record.label, record.href, mentions);
  return comment;
}

/** The caller's own live comment, or the CommentError that explains why not (404 absent/deleted/other company, 403 not theirs). */
async function ownLiveComment(companyId: string, userId: string, id: string): Promise<DbRow> {
  const row = ((await SELECT_ONE(companyId, id)) as DbRow[])[0];
  if (!row || row.deleted_at != null) throw new CommentError(404, 'Comment not found');
  if (String(row.author_id) !== userId) throw new CommentError(403, 'You can change only your own comments');
  return row;
}

export async function editComment(
  companyId: string, userId: string, id: string, rawBody: unknown, rawMentions?: readonly string[],
): Promise<RecordComment> {
  await assertNotImpersonating();
  const row = await ownLiveComment(companyId, userId, id);
  const body = cleanCommentBody(rawBody);
  const mentions = cleanMentions(rawMentions, userId);
  await assertMembers(companyId, mentions);
  const record = await findCommentRecord(companyId, String(row.record_type) as CommentRecordType, String(row.record_id));
  await sql`UPDATE record_comments SET body = ${body}, mentions = ${mentions}::TEXT[]
             WHERE company_id = ${companyId}::UUID AND id = ${id}::UUID`;
  const comment = toComment(((await SELECT_ONE(companyId, id)) as DbRow[])[0] as DbRow);
  // One notification per person per comment (the dedupe key), so a person named before is not told again.
  if (record) await notifyMentions(companyId, comment, record.label, record.href, mentions);
  return comment;
}

export async function deleteComment(companyId: string, userId: string, id: string): Promise<void> {
  await assertNotImpersonating();
  await ownLiveComment(companyId, userId, id);
  await sql`UPDATE record_comments SET deleted_at = clock_timestamp()
             WHERE company_id = ${companyId}::UUID AND id = ${id}::UUID`;
}
