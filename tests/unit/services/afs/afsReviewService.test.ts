// tests/unit/services/afs/afsReviewService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  ReviewError,
  markSectionReviewed,
  signOffSection,
  submitDocumentForReview,
  signOffDocument,
  promoteToPartnerReview,
  assertDocumentEditable,
} from '@/modules/accounting/services/afs/afsReviewService';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const CID = 'company-1';
const DOC = 'doc-1';
const SEC = 'sec-1';
const USER = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── signOffSection ──────────────────────────────────────────────────────────

describe('signOffSection', () => {
  it('succeeds when zero unresolved comments and doc is editable', async () => {
    // lockSectionForWrite
    mockSql.mockResolvedValueOnce([{
      id: SEC, document_id: DOC, section_type: 'note_1', status: 'reviewed',
      reviewed_by: null, signed_off_by: null, document_status: 'in_review', signing_requested_at: null,
    }]);
    // countUnresolvedComments
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    // UPDATE ... RETURNING id
    mockSql.mockResolvedValueOnce([{ id: DOC }]);

    const result = await signOffSection(CID, DOC, SEC, USER);
    expect(result).toEqual({ sectionId: SEC, newStatus: 'signed_off' });
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('blocks when unresolved comments exist', async () => {
    mockSql.mockResolvedValueOnce([{
      id: SEC, document_id: DOC, section_type: 'note_1', status: 'reviewed',
      reviewed_by: null, signed_off_by: null, document_status: 'in_review', signing_requested_at: null,
    }]);
    mockSql.mockResolvedValueOnce([{ cnt: 2 }]);

    try {
      await signOffSection(CID, DOC, SEC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('UNRESOLVED_COMMENTS');
    }
  });

  it('blocks when document is signed_off', async () => {
    mockSql.mockResolvedValueOnce([{
      id: SEC, document_id: DOC, section_type: 'note_1', status: 'reviewed',
      reviewed_by: null, signed_off_by: null, document_status: 'signed_off', signing_requested_at: null,
    }]);

    try {
      await signOffSection(CID, DOC, SEC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('DOCUMENT_LOCKED');
    }
  });

  it('blocks when document is filed', async () => {
    mockSql.mockResolvedValueOnce([{
      id: SEC, document_id: DOC, section_type: 'note_1', status: 'reviewed',
      reviewed_by: null, signed_off_by: null, document_status: 'filed', signing_requested_at: null,
    }]);

    try {
      await signOffSection(CID, DOC, SEC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('DOCUMENT_LOCKED');
    }
  });

  it('throws NOT_FOUND when section does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await signOffSection(CID, DOC, SEC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('NOT_FOUND');
    }
  });
});

// ── submitDocumentForReview ─────────────────────────────────────────────────

describe('submitDocumentForReview', () => {
  it('succeeds when all mandatory sections are reviewed', async () => {
    // getDocument
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'draft', signing_requested_at: null }]);
    // countMandatorySectionsBelow
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);
    // UPDATE ... RETURNING id
    mockSql.mockResolvedValueOnce([{ id: DOC }]);

    const result = await submitDocumentForReview(CID, DOC, USER);
    expect(result).toEqual({ documentId: DOC, newStatus: 'in_review' });
  });

  it('blocks when mandatory sections are not ready', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'draft', signing_requested_at: null }]);
    mockSql.mockResolvedValueOnce([{ cnt: 3 }]);

    try {
      await submitDocumentForReview(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('SECTIONS_NOT_READY');
    }
  });

  it('throws NOT_FOUND when document does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await submitDocumentForReview(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('NOT_FOUND');
    }
  });

  it('throws INVALID_TRANSITION when document is not draft', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'in_review', signing_requested_at: null }]);

    try {
      await submitDocumentForReview(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('INVALID_TRANSITION');
    }
  });
});

// ── assertDocumentEditable ──────────────────────────────────────────────────

describe('assertDocumentEditable', () => {
  it('passes for draft', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'draft', signing_requested_at: null }]);
    await expect(assertDocumentEditable(CID, DOC)).resolves.toBeUndefined();
  });

  it('passes for in_review', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'in_review', signing_requested_at: null }]);
    await expect(assertDocumentEditable(CID, DOC)).resolves.toBeUndefined();
  });

  it('throws DOCUMENT_LOCKED for signed_off', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'signed_off' }]);

    try {
      await assertDocumentEditable(CID, DOC);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('DOCUMENT_LOCKED');
    }
  });

  it('throws DOCUMENT_LOCKED for filed', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'filed' }]);

    try {
      await assertDocumentEditable(CID, DOC);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('DOCUMENT_LOCKED');
    }
  });

  it('throws NOT_FOUND when document does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await assertDocumentEditable(CID, DOC);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('NOT_FOUND');
    }
  });
});

// ── markSectionReviewed ─────────────────────────────────────────────────────

describe('markSectionReviewed', () => {
  it('succeeds when document is editable', async () => {
    mockSql.mockResolvedValueOnce([{
      id: SEC, document_id: DOC, section_type: 'note_1', status: 'ai_enhanced',
      reviewed_by: null, signed_off_by: null, document_status: 'draft', signing_requested_at: null,
    }]);
    mockSql.mockResolvedValueOnce([]);

    const result = await markSectionReviewed(CID, DOC, SEC, USER);
    expect(result).toEqual({ sectionId: SEC, newStatus: 'reviewed' });
  });

  it('throws DOCUMENT_LOCKED when document is signed_off', async () => {
    mockSql.mockResolvedValueOnce([{
      id: SEC, document_id: DOC, section_type: 'note_1', status: 'reviewed',
      reviewed_by: null, signed_off_by: null, document_status: 'signed_off', signing_requested_at: null,
    }]);

    try {
      await markSectionReviewed(CID, DOC, SEC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('DOCUMENT_LOCKED');
    }
  });

  it('throws NOT_FOUND when section does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await markSectionReviewed(CID, DOC, SEC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('NOT_FOUND');
    }
  });
});

// ── signOffDocument ─────────────────────────────────────────────────────────
// Order: getDocument → countUnresolvedCommentsForDocument → countMandatorySectionsBelow → UPDATE

describe('signOffDocument', () => {
  it('succeeds when no unresolved comments and all mandatory sections are signed off', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'in_review', signing_requested_at: null }]); // getDocument
    mockSql.mockResolvedValueOnce([{ n: 0 }]);                          // countUnresolvedCommentsForDocument
    mockSql.mockResolvedValueOnce([{ cnt: 0 }]);                        // countMandatorySectionsBelow
    mockSql.mockResolvedValueOnce([{ id: DOC }]);                        // UPDATE ... RETURNING id

    const result = await signOffDocument(CID, DOC, USER);
    expect(result).toEqual({ documentId: DOC, newStatus: 'signed_off' });
  });

  it('blocks on UNRESOLVED_COMMENTS before checking mandatory sections', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'partner_review', signing_requested_at: null }]); // getDocument
    mockSql.mockResolvedValueOnce([{ n: 3 }]);                               // countUnresolvedCommentsForDocument

    try {
      await signOffDocument(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('UNRESOLVED_COMMENTS');
    }
  });

  it('blocks when mandatory sections are not signed off', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'partner_review', signing_requested_at: null }]); // getDocument
    mockSql.mockResolvedValueOnce([{ n: 0 }]);                               // countUnresolvedCommentsForDocument
    mockSql.mockResolvedValueOnce([{ cnt: 2 }]);                             // countMandatorySectionsBelow

    try {
      await signOffDocument(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('SECTIONS_NOT_READY');
    }
  });

  it('throws INVALID_TRANSITION when document status is draft', async () => {
    mockSql.mockResolvedValueOnce([{ id: DOC, status: 'draft', signing_requested_at: null }]);

    try {
      await signOffDocument(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('INVALID_TRANSITION');
    }
  });

  it('throws NOT_FOUND when document does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    try {
      await signOffDocument(CID, DOC, USER);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).code).toBe('NOT_FOUND');
    }
  });
});
