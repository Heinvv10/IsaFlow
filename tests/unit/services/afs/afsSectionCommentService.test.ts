// tests/unit/services/afs/afsSectionCommentService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
// The section write guard (document binding, lock, locked-document refusal) is proven against
// real PostgreSQL in tests/integration/controls/afsSectionWritesHttp.int.test.ts.
vi.mock('@/modules/accounting/services/afs/afsSectionAttestation',()=>({lockSectionForWrite:vi.fn().mockResolvedValue({
  id:'sec-1',documentId:'doc-1',sectionType:'note_1',status:'auto_generated',reviewedBy:null,signedOffBy:null})}));

import { sql } from '@/lib/neon';
import { lockSectionForWrite } from '@/modules/accounting/services/afs/afsSectionAttestation';
import { ReviewError } from '@/modules/accounting/services/afs/afsReviewError';
import {
  CommentError,
  listComments,
  addComment,
  resolveComment,
  deleteComment,
} from '@/modules/accounting/services/afs/afsSectionCommentService';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const CID = 'company-1';
const SEC = 'sec-1';
const DOC = 'doc-1';
const USER = 'user-1';
const COMMENT = 'comment-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── addComment ──────────────────────────────────────────────────────────────

describe('addComment', () => {
  const commentRow = {
    id: COMMENT, section_id: SEC, company_id: CID,
    author_id: USER, body: 'Test comment', resolved: false,
    resolved_by: null, resolved_at: null, parent_id: null,
    created_at: new Date(),
  };

  it('creates a top-level comment', async () => {
    // INSERT RETURNING
    mockSql.mockResolvedValueOnce([commentRow]);

    const result = await addComment(CID, DOC, SEC, USER, 'Test comment');
    expect(result.id).toBe(COMMENT);
    expect(result.parentId).toBeNull();
  });

  it('creates a reply when parentId is valid', async () => {
    // parent validation
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);
    // INSERT RETURNING
    mockSql.mockResolvedValueOnce([{ ...commentRow, parent_id: 'parent-1' }]);

    const result = await addComment(CID, DOC, SEC, USER, 'Reply', 'parent-1');
    expect(result.parentId).toBe('parent-1');
  });

  it('rejects invalid parentId', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await addComment(CID, DOC, SEC, USER, 'Reply', 'bad-parent');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommentError);
      expect((err as CommentError).code).toBe('NOT_FOUND');
    }
  });

  it('refuses a section the guard does not place in this document', async () => {
    vi.mocked(lockSectionForWrite).mockRejectedValueOnce(new ReviewError('Section not found', 'NOT_FOUND'));

    try {
      await addComment(CID, DOC, SEC, USER, 'Test');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('NOT_FOUND');
    }
  });
});

// ── resolveComment ──────────────────────────────────────────────────────────

describe('resolveComment', () => {
  it('resolves an existing comment', async () => {
    mockSql.mockResolvedValueOnce([{
      id: COMMENT, section_id: SEC, company_id: CID,
      author_id: USER, body: 'Test', resolved: true,
      resolved_by: USER, resolved_at: new Date(), parent_id: null,
      created_at: new Date(),
    }]);

    const result = await resolveComment(CID, DOC, SEC, COMMENT, USER);
    expect(result.resolved).toBe(true);
    expect(result.resolvedBy).toBe(USER);
  });

  it('throws NOT_FOUND when comment not found', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await resolveComment(CID, DOC, SEC, COMMENT, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommentError);
      expect((err as CommentError).code).toBe('NOT_FOUND');
    }
  });
});

// ── deleteComment ───────────────────────────────────────────────────────────

describe('deleteComment', () => {
  it('deletes when requester is the author', async () => {
    mockSql.mockResolvedValueOnce([{ author_id: USER }]);
    mockSql.mockResolvedValueOnce([]);

    await expect(deleteComment(CID, COMMENT, USER)).resolves.toBeUndefined();
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('throws FORBIDDEN when requester is not the author', async () => {
    mockSql.mockResolvedValueOnce([{ author_id: 'other-user' }]);

    try {
      await deleteComment(CID, COMMENT, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommentError);
      expect((err as CommentError).code).toBe('FORBIDDEN');
    }
  });

  it('throws NOT_FOUND when comment not found', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await deleteComment(CID, COMMENT, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommentError);
      expect((err as CommentError).code).toBe('NOT_FOUND');
    }
  });
});

// ── listComments ────────────────────────────────────────────────────────────

describe('listComments', () => {
  it('returns mapped comments ordered by created_at', async () => {
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]); // the section belongs to this document
    mockSql.mockResolvedValueOnce([
      {
        id: 'c1', section_id: SEC, company_id: CID, author_id: USER,
        body: 'First', resolved: false, resolved_by: null,
        resolved_at: null, parent_id: null, created_at: new Date('2026-01-01'),
      },
      {
        id: 'c2', section_id: SEC, company_id: CID, author_id: USER,
        body: 'Second', resolved: false, resolved_by: null,
        resolved_at: null, parent_id: 'c1', created_at: new Date('2026-01-02'),
      },
    ]);

    const result = await listComments(CID, DOC, SEC);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('c1');
    expect(result[1].parentId).toBe('c1');
  });

  it('returns empty array when no comments', async () => {
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]); // the section belongs to this document
    mockSql.mockResolvedValueOnce([]);
    const result = await listComments(CID, DOC, SEC);
    expect(result).toEqual([]);
  });
});
