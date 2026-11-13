/**
 * Comment text rules, pure. A comment is plain text: the server never interprets it as markup and the UI
 * renders it as text. NUL is dropped (Postgres text cannot hold it); the limit counts characters as the
 * table's CHECK does (code points).
 */
export const MAX_COMMENT_BODY = 4000;
export const MAX_MENTIONS = 10
/** Live comments one record can hold (the list shows the newest of them). */
export const MAX_COMMENTS_PER_RECORD = 500;

export class CommentError extends Error {
  constructor(readonly status: 400 | 403 | 404, message: string) {
    super(message);
    this.name = 'CommentError';
  }
}

/** The body as stored: NUL dropped, trimmed. A blank or over-long body is a 400 (nothing is cut silently). */
export function cleanCommentBody(raw: unknown): string {
  if (typeof raw !== 'string') throw new CommentError(400, 'A comment needs text');
  const body = raw.replace(/\u0000/g, '').trim();
  if (body === '') throw new CommentError(400, 'A comment needs text');
  if (Array.from(body).length > MAX_COMMENT_BODY) {
    throw new CommentError(400, `A comment is at most ${MAX_COMMENT_BODY} characters`);
  }
  return body;
}

/** The people named: distinct, never the author, at most MAX_MENTIONS. */
export function cleanMentions(raw: readonly string[] | undefined, authorId: string): string[] {
  const ids = [...new Set((raw ?? []).map((m) => m.trim()).filter((m) => m !== '' && m !== authorId))];
  if (ids.length > MAX_MENTIONS) throw new CommentError(400, `A comment mentions at most ${MAX_MENTIONS} people`);
  return ids;
}

/** A notification body: the first 200 characters of the comment, whitespace collapsed. */
export function mentionSnippet(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > 200 ? `${chars.slice(0, 199).join('')}…` : flat;
}
