/** The comments route, as the panel calls it. Every call goes through assertOk: apiFetch resolves on 4xx. */
import { apiFetch, assertOk } from '@/lib/apiFetch';
import type { CommentRecordType } from '@/modules/accounting/services/comments/commentRecords';
import type { Mentionable, RecordComment } from '@/modules/accounting/services/comments/recordCommentService';

export type { CommentRecordType, Mentionable, RecordComment };
export interface CommentsRead { comments: RecordComment[]; mentionable: Mentionable[]; olderHidden: number }

const BASE = '/api/accounting/record-comments';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function readComments(type: CommentRecordType, recordId: string): Promise<CommentsRead> {
  const res = await apiFetch(`${BASE}?recordType=${type}&recordId=${recordId}`);
  await assertOk(res, 'Could not load the comments - try again');
  return ((await res.json()) as { data: CommentsRead }).data;
}

export async function addComment(type: CommentRecordType, recordId: string, body: string, mentions: string[]): Promise<RecordComment> {
  const res = await apiFetch(BASE, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ recordType: type, recordId, body, mentions }) });
  await assertOk(res, 'Could not post the comment - try again');
  return ((await res.json()) as { data: RecordComment }).data;
}

export async function saveComment(id: string, body: string, mentions: string[]): Promise<RecordComment> {
  const res = await apiFetch(`${BASE}?id=${id}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ body, mentions }) });
  await assertOk(res, 'Could not save the comment - try again');
  return ((await res.json()) as { data: RecordComment }).data;
}

export async function removeComment(id: string): Promise<void> {
  await assertOk(await apiFetch(`${BASE}?id=${id}`, { method: 'DELETE' }), 'Could not delete the comment - try again');
}
