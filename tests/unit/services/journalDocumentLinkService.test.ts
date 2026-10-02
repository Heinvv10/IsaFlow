/**
 * journalDocumentLinkService — link/unlink a captured document to a posted
 * journal (VAT-gaps batch item 1, migration 706). Every refusal is pre-write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const m = vi.hoisted(() => ({
  sql: Object.assign(vi.fn(), { unsafe: vi.fn((s: string) => s) }), logAuditOrThrow: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: (_name: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({
  logAuditOrThrow: m.logAuditOrThrow,
}));

import {
  linkDocumentToJournal, unlinkDocumentFromJournal, getActiveLinksForJournal,
  JournalDocumentLinkRefusal,
} from '@/modules/accounting/services/gl/journalDocumentLinkService';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const JOURNAL = 'cccccccc-0000-4000-8000-cccccccccccc';
const DOC = 'dddddddd-0000-4000-8000-dddddddddddd';

beforeEach(() => {
  vi.clearAllMocks();
  m.logAuditOrThrow.mockResolvedValue(undefined);
});

describe('linkDocumentToJournal', () => {
  it('refuses a blank reason before any write', async () => {
    await expect(linkDocumentToJournal(COMPANY, JOURNAL, DOC, USER, '   '))
      .rejects.toBeInstanceOf(JournalDocumentLinkRefusal);
    expect(m.sql).not.toHaveBeenCalled();
  });

  it('refuses a journal that is not found, not posted, or reversed', async () => {
    m.sql.mockResolvedValueOnce([]); // loadLinkableJournal
    await expect(linkDocumentToJournal(COMPANY, JOURNAL, DOC, USER, 'Invoice attached'))
      .rejects.toBeInstanceOf(JournalDocumentLinkRefusal);
  });

  it('refuses a document not found in this company', async () => {
    m.sql
      .mockResolvedValueOnce([{ id: JOURNAL }]) // loadLinkableJournal
      .mockResolvedValueOnce([]); // documentBelongsToCompany
    await expect(linkDocumentToJournal(COMPANY, JOURNAL, DOC, USER, 'Invoice attached'))
      .rejects.toBeInstanceOf(JournalDocumentLinkRefusal);
  });

  it('refuses a document already backing a posted journal via source_document_id', async () => {
    m.sql
      .mockResolvedValueOnce([{ id: JOURNAL }]) // loadLinkableJournal
      .mockResolvedValueOnce([{ id: DOC }]) // documentBelongsToCompany
      .mockResolvedValueOnce([{ id: 'other-je' }]); // assertDocumentNotAlreadyPosted: source_document_id
    await expect(linkDocumentToJournal(COMPANY, JOURNAL, DOC, USER, 'Invoice attached'))
      .rejects.toThrow(/already referenced/);
  });

  it('refuses a document already an active link (one document, one claim)', async () => {
    m.sql
      .mockResolvedValueOnce([{ id: JOURNAL }]) // loadLinkableJournal
      .mockResolvedValueOnce([{ id: DOC }]) // documentBelongsToCompany
      .mockResolvedValueOnce([]) // source_document_id check: clear
      .mockResolvedValueOnce([{ journal_entry_id: 'other-je' }]); // active link check
    await expect(linkDocumentToJournal(COMPANY, JOURNAL, DOC, USER, 'Invoice attached'))
      .rejects.toThrow(/already linked/);
  });

  it('links, and audit-logs it', async () => {
    m.sql
      .mockResolvedValueOnce([{ id: JOURNAL }]) // loadLinkableJournal
      .mockResolvedValueOnce([{ id: DOC }]) // documentBelongsToCompany
      .mockResolvedValueOnce([]) // source_document_id check
      .mockResolvedValueOnce([]) // active link check
      .mockResolvedValueOnce([{
        id: 'link-1', journal_entry_id: JOURNAL, captured_document_id: DOC,
        linked_by: USER, linked_at: new Date('2026-09-26T00:00:00Z'), reason: 'Invoice attached',
      }]);
    const link = await linkDocumentToJournal(COMPANY, JOURNAL, DOC, USER, 'Invoice attached');
    expect(link).toMatchObject({ id: 'link-1', journalEntryId: JOURNAL, capturedDocumentId: DOC });
    expect(m.logAuditOrThrow).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY, userId: USER, action: 'update', entityType: 'gl_journal_entry', entityId: JOURNAL,
    }));
  });

  // Item 4 (VAT-gaps review): a concurrent double-link loses the race on
  // migration 706's partial unique index. The sequential pre-check (the
  // "already an active link" test above) cannot catch that race — only the
  // INSERT itself can — so the 23505 on THAT constraint must convert to the
  // same JournalDocumentLinkRefusal, not surface as an uncaught 500.
  it('converts a concurrent-link 23505 on the active-link index to JournalDocumentLinkRefusal', async () => {
    m.sql
      .mockResolvedValueOnce([{ id: JOURNAL }]) // loadLinkableJournal
      .mockResolvedValueOnce([{ id: DOC }]) // documentBelongsToCompany
      .mockResolvedValueOnce([]) // source_document_id check: clear
      .mockResolvedValueOnce([]) // active link check: clear (raced after this read)
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), {
        code: '23505', constraint: 'uq_gl_journal_document_links_active_document',
      }));
    await expect(linkDocumentToJournal(COMPANY, JOURNAL, DOC, USER, 'Invoice attached'))
      .rejects.toBeInstanceOf(JournalDocumentLinkRefusal);
  });

  it('rethrows a 23505 on a different constraint (or any other error) unconverted', async () => {
    m.sql
      .mockResolvedValueOnce([{ id: JOURNAL }])
      .mockResolvedValueOnce([{ id: DOC }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(Object.assign(new Error('fk violation'), { code: '23503' }));
    await expect(linkDocumentToJournal(COMPANY, JOURNAL, DOC, USER, 'Invoice attached'))
      .rejects.not.toBeInstanceOf(JournalDocumentLinkRefusal);
  });
});

describe('unlinkDocumentFromJournal', () => {
  it('refuses a blank reason before any write', async () => {
    await expect(unlinkDocumentFromJournal(COMPANY, JOURNAL, DOC, USER, ''))
      .rejects.toBeInstanceOf(JournalDocumentLinkRefusal);
    expect(m.sql).not.toHaveBeenCalled();
  });

  it('refuses when no active link exists', async () => {
    m.sql.mockResolvedValueOnce([]);
    await expect(unlinkDocumentFromJournal(COMPANY, JOURNAL, DOC, USER, 'wrong doc'))
      .rejects.toBeInstanceOf(JournalDocumentLinkRefusal);
  });

  it('unlinks and audit-logs it', async () => {
    m.sql.mockResolvedValueOnce([{ id: 'link-1' }]);
    await unlinkDocumentFromJournal(COMPANY, JOURNAL, DOC, USER, 'wrong doc');
    expect(m.logAuditOrThrow).toHaveBeenCalledWith(expect.objectContaining({ entityId: JOURNAL }));
  });
});

describe('getActiveLinksForJournal', () => {
  it('maps rows', async () => {
    m.sql.mockResolvedValueOnce([{
      id: 'link-1', journal_entry_id: JOURNAL, captured_document_id: DOC,
      linked_by: USER, linked_at: new Date('2026-09-26T00:00:00Z'), reason: 'r',
    }]);
    const links = await getActiveLinksForJournal(COMPANY, JOURNAL);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ id: 'link-1', capturedDocumentId: DOC });
  });
});
