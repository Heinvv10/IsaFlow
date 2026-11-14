/** Comment text rules (M14): plain text, trimmed, limit counted in characters, mentions distinct and never the author. */
import { describe, it, expect } from 'vitest';
import { cleanCommentBody, cleanMentions, mentionSnippet, CommentError, MAX_COMMENT_BODY, MAX_MENTIONS } from '@/modules/accounting/services/comments/commentText';

describe('cleanCommentBody', () => {
  it('trims, drops NUL, and keeps markup as the text it is (no stripping, no encoding)', () => {
    expect(cleanCommentBody('  hi\u0000 <img src=x onerror=alert(1)>  ')).toBe('hi <img src=x onerror=alert(1)>');
  });
  it.each(['', '   \n\t ', '\u0000', null, undefined, 42])('refuses %j as a 400', (v) => {
    expect(() => cleanCommentBody(v)).toThrowError(expect.objectContaining({ status: 400 }));
  });
  it('accepts exactly the limit in characters and refuses one more (emoji count once)', () => {
    expect(cleanCommentBody('😀'.repeat(MAX_COMMENT_BODY))).toHaveLength(MAX_COMMENT_BODY * 2);
    expect(() => cleanCommentBody('a'.repeat(MAX_COMMENT_BODY + 1))).toThrow(CommentError);
  });
});

describe('cleanMentions', () => {
  it('is distinct, trimmed, and never the author', () => {
    expect(cleanMentions([' u2 ', 'u2', 'me', '', 'u3'], 'me')).toEqual(['u2', 'u3']);
    expect(cleanMentions(undefined, 'me')).toEqual([]);
  });
  it('refuses more than the limit', () => {
    const many = Array.from({ length: MAX_MENTIONS + 1 }, (_, i) => `u${i}`);
    expect(() => cleanMentions(many, 'me')).toThrowError(expect.objectContaining({ status: 400 }));
  });
});

describe('mentionSnippet', () => {
  it('collapses whitespace and cuts at 200 characters', () => {
    expect(mentionSnippet('a\n\n  b')).toBe('a b');
    expect(Array.from(mentionSnippet('x'.repeat(500)))).toHaveLength(200);
  });
});
