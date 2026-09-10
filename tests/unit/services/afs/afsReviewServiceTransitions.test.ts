// tests/unit/services/afs/afsReviewServiceTransitions.test.ts
// promoteToPartnerReview tests (split from afsReviewService.test.ts to stay under 300 lines)
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  ReviewError,
  promoteToPartnerReview,
} from '@/modules/accounting/services/afs/afsReviewService';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const CID = 'company-1';
const DOC = 'doc-1';
const USER = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── promoteToPartnerReview ──────────────────────────────────────────────────
// Order: getDocument → countMandatorySectionsBelow → countUnresolvedCommentsForDocument → UPDATE

describe('promoteToPartnerReview', () => {
  it('succeeds when status is in_review, all sections reviewed, no unresolved comments', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'in_review' }]); // getDocument
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);                        // countMandatorySectionsBelow
    mockSql.mockResolvedValueOnce([{ n: 0 }]);                          // countUnresolvedCommentsForDocument
    mockSql.mockResolvedValueOnce([{ id: DOC }]);                        // UPDATE ... RETURNING id

    const result = await promoteToPartnerReview(CID, DOC, USER);
    expect(result).toEqual({ documentId: DOC, newStatus: 'partner_review' });
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('throws SECTIONS_NOT_READY when mandatory sections below reviewed', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'in_review' }]); // getDocument
    mockSql.mockResolvedValueOnce([{ cnt: 2 }]);                        // countMandatorySectionsBelow

    try {
      await promoteToPartnerReview(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('SECTIONS_NOT_READY');
    }
  });

  it('throws UNRESOLVED_COMMENTS when unresolved comments exist', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'in_review' }]); // getDocument
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);                        // countMandatorySectionsBelow (OK)
    mockSql.mockResolvedValueOnce([{ n: 5 }]);                          // countUnresolvedCommentsForDocument

    try {
      await promoteToPartnerReview(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('UNRESOLVED_COMMENTS');
    }
  });

  it('throws INVALID_TRANSITION when document status is not in_review', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'draft' }]);

    try {
      await promoteToPartnerReview(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('INVALID_TRANSITION');
    }
  });

  it('throws INVALID_TRANSITION when document is already partner_review', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'partner_review' }]);

    try {
      await promoteToPartnerReview(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('INVALID_TRANSITION');
    }
  });

  it('throws NOT_FOUND when document does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await promoteToPartnerReview(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('NOT_FOUND');
    }
  });
});
