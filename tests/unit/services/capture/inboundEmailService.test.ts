// RED phase — written before implementation
/**
 * Unit tests for inboundEmailService.ts
 *
 * Covers: ingestPostmarkPayload — inbox lookup, sender-domain check,
 * attachment filtering, and captured_documents + capture_events insertion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock ──────────────────────────────────────────────────────────────
const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  ingestPostmarkPayload,
  type PostmarkInboundPayload,
  type PostmarkAttachment,
} from '@/modules/accounting/services/capture/inboundEmailService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID = 'cccccccc-0000-0000-0000-000000000001';
const INBOX_ID   = 'dddddddd-0000-0000-0000-000000000002';
const DOC_ID     = 'eeeeeeee-0000-0000-0000-000000000003';
const EVENT_ID   = 'ffffffff-0000-0000-0000-000000000004';
const TO_ADDRESS = 'cap-a1b2c3@inbox.isaflow.co.za';

const pdfAttachment: PostmarkAttachment = {
  Name: 'invoice.pdf',
  ContentType: 'application/pdf',
  Content: 'JVBERi0xLjQ=', // fake base64
  ContentLength: 1024,
};

const imageAttachment: PostmarkAttachment = {
  Name: 'photo.jpg',
  ContentType: 'image/jpeg',
  Content: '/9j/4AAQSkZJRgAB',
  ContentLength: 512,
};

const nonInvoiceAttachment: PostmarkAttachment = {
  Name: 'notes.txt',
  ContentType: 'text/plain',
  Content: 'aGVsbG8=',
  ContentLength: 8,
};

function makePayload(overrides: Partial<PostmarkInboundPayload> = {}): PostmarkInboundPayload {
  return {
    To: `Test Inbox <${TO_ADDRESS}>`,
    From: 'supplier@acmecorp.co.za',
    Subject: 'Invoice March 2026',
    Attachments: [pdfAttachment],
    ...overrides,
  };
}

function makeInboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INBOX_ID,
    company_id: COMPANY_ID,
    allowed_sender_domains: null,
    ...overrides,
  };
}

// ── Helpers for multi-call mocking ────────────────────────────────────────────
// Each test sets up sql call sequence: [inboxLookup, docInsert, eventInsert]
function mockHappyPath(attachmentCount = 1) {
  // Inbox lookup
  vi.mocked(sql).mockResolvedValueOnce([makeInboxRow()] as never);
  // One doc + event pair per attachment
  for (let i = 0; i < attachmentCount; i++) {
    vi.mocked(sql).mockResolvedValueOnce([{ id: DOC_ID }] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: EVENT_ID }] as never);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ingestPostmarkPayload', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Rejection: no matching inbox ───────────────────────────────────────────

  it('rejects payload where To matches no inbox in DB', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never); // no inbox found

    const result = await ingestPostmarkPayload(makePayload());

    expect(result).toEqual({ rejected: 'no matching inbox' });
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });

  it('rejects when To field is empty and ToFull is absent', async () => {
    // No inbox lookup issued when address cannot be parsed
    const result = await ingestPostmarkPayload(
      makePayload({ To: '', ToFull: undefined }),
    );

    expect(result).toEqual({ rejected: 'no matching inbox' });
  });

  it('resolves address from ToFull[0].Email when To is absent', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeInboxRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: DOC_ID }] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: EVENT_ID }] as never);

    const result = await ingestPostmarkPayload(
      makePayload({ To: undefined, ToFull: [{ Email: TO_ADDRESS, Name: 'Inbox' }] }),
    );

    expect('captureEventId' in result).toBe(true);
  });

  // ── Rejection: sender domain not allow-listed ──────────────────────────────

  it('rejects when sender domain not in allowed_sender_domains', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeInboxRow({ allowed_sender_domains: ['trusted.co.za'] }),
    ] as never);

    const result = await ingestPostmarkPayload(
      makePayload({ From: 'attacker@evil.com' }),
    );

    expect(result).toEqual({ rejected: 'sender not allow-listed' });
    // No inserts issued
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });

  it('accepts sender when their domain is in allowed_sender_domains', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeInboxRow({ allowed_sender_domains: ['acmecorp.co.za'] }),
    ] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: DOC_ID }] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: EVENT_ID }] as never);

    const result = await ingestPostmarkPayload(
      makePayload({ From: 'supplier@acmecorp.co.za' }),
    );

    expect('captureEventId' in result).toBe(true);
  });

  it('accepts any sender when allowed_sender_domains is null (open inbox)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeInboxRow({ allowed_sender_domains: null })] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: DOC_ID }] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: EVENT_ID }] as never);

    const result = await ingestPostmarkPayload(
      makePayload({ From: 'anyone@randomdomain.net' }),
    );

    expect('captureEventId' in result).toBe(true);
  });

  // ── Rejection: no attachments ──────────────────────────────────────────────

  it('rejects when Attachments array is absent', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeInboxRow()] as never);

    const result = await ingestPostmarkPayload(
      makePayload({ Attachments: undefined }),
    );

    expect(result).toEqual({ rejected: 'no attachments' });
  });

  it('rejects when Attachments is an empty array', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeInboxRow()] as never);

    const result = await ingestPostmarkPayload(makePayload({ Attachments: [] }));

    expect(result).toEqual({ rejected: 'no attachments' });
  });

  it('rejects when all attachments are non-invoice mime types', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeInboxRow()] as never);

    const result = await ingestPostmarkPayload(
      makePayload({ Attachments: [nonInvoiceAttachment] }),
    );

    expect(result).toEqual({ rejected: 'no attachments' });
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('accepts a valid PDF payload and returns captureEventId + companyId', async () => {
    mockHappyPath(1);

    const result = await ingestPostmarkPayload(makePayload());

    expect(result).toEqual({
      captureEventId: EVENT_ID,
      captureEventIds: [EVENT_ID],
      companyId: COMPANY_ID,
    });
  });

  it('accepts an image/jpeg attachment', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeInboxRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: DOC_ID }] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: EVENT_ID }] as never);

    const result = await ingestPostmarkPayload(
      makePayload({ Attachments: [imageAttachment] }),
    );

    expect('captureEventId' in result).toBe(true);
  });

  it('creates one captured_document row + one capture_event row per invoice attachment', async () => {
    // Two PDF attachments
    const att2: PostmarkAttachment = { ...pdfAttachment, Name: 'invoice2.pdf' };
    vi.mocked(sql).mockResolvedValueOnce([makeInboxRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: DOC_ID }] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: EVENT_ID }] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'doc-id-2' }] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'event-id-2' }] as never);

    await ingestPostmarkPayload(makePayload({ Attachments: [pdfAttachment, att2] }));

    // 1 inbox lookup + 2×(doc insert + event insert) = 5 sql calls
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(5);
  });

  it('returns the first captureEventId when multiple attachments are present', async () => {
    const att2: PostmarkAttachment = { ...pdfAttachment, Name: 'invoice2.pdf' };
    vi.mocked(sql).mockResolvedValueOnce([makeInboxRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'doc-1' }] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'event-first' }] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'doc-2' }] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: 'event-second' }] as never);

    const result = await ingestPostmarkPayload(makePayload({ Attachments: [pdfAttachment, att2] }));

    expect(result).toEqual({
      captureEventId: 'event-first',
      captureEventIds: ['event-first', 'event-second'],
      companyId: COMPANY_ID,
    });
  });

  it('skips non-invoice attachments and only processes PDF/image ones', async () => {
    // One text + one PDF — only PDF should be processed
    vi.mocked(sql).mockResolvedValueOnce([makeInboxRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: DOC_ID }] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ id: EVENT_ID }] as never);

    const result = await ingestPostmarkPayload(
      makePayload({ Attachments: [nonInvoiceAttachment, pdfAttachment] }),
    );

    expect(result).toEqual({
      captureEventId: EVENT_ID,
      captureEventIds: [EVENT_ID],
      companyId: COMPANY_ID,
    });
    // 1 inbox + 1 doc + 1 event (text skipped)
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(3);
  });
});
