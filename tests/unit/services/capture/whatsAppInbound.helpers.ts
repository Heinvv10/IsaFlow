// RED phase — written before implementation
/**
 * Unit tests for whatsAppInboundService.ts — PRD-05 Phase 8
 *
 * Covers: ingestTwilioPayload
 *   - Unknown To → rejected
 *   - Text-only (NumMedia=0) → parsedCommand set, no events
 *   - Media with TWILIO env unset → skipped gracefully
 *   - Media with TWILIO env set → document + event created, routeEvent called
 *   - Two media → two events
 *   - Media + text command → both paths fire
 *   - Workstream D: open query reply routing (attach media, mark replied)
 */

import { vi } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  sqlMock, storeMock, sha256Mock, routeEventMock,
  findOpenQueryMock, attachReplyMediaMock, markQueryRepliedMock,
} = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  const storeMock = vi.fn().mockResolvedValue({
    bucket: 'captured-documents',
    path: 'company/doc-id',
    hash: 'abc123',
    size: 1024,
    documentId: 'doc-id',
  });
  const sha256Mock = vi.fn().mockReturnValue('deadbeef');
  const routeEventMock = vi.fn().mockResolvedValue(undefined);
  const findOpenQueryMock = vi.fn();
  const attachReplyMediaMock = vi.fn(async () => true);
  const markQueryRepliedMock = vi.fn(async () => undefined);
  return {
    sqlMock, storeMock, sha256Mock, routeEventMock,
    findOpenQueryMock, attachReplyMediaMock, markQueryRepliedMock,
  };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/documentStorage', () => ({
  storeCapturedBytes: storeMock,
  sha256: sha256Mock,
}));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({
  routeEvent: routeEventMock,
}));
vi.mock('@/modules/accounting/services/capture/bankTxQueryReplyService', () => ({
  findOpenQuery: (...a: unknown[]) => findOpenQueryMock(...(a as [string, string])),
  attachReplyMedia: (...a: unknown[]) => attachReplyMediaMock(...(a as [])),
  markQueryReplied: (...a: unknown[]) => markQueryRepliedMock(...(a as [])),
}));

import {
  ingestTwilioPayload as ingestRawPayload,
  type TwilioInboundPayload,
} from '@/modules/accounting/services/capture/whatsAppInboundService';

const ingestVerifiedPayload = (payload: TwilioInboundPayload) => ingestRawPayload(payload);
const ingestTwilioPayload = (payload: TwilioInboundPayload) => ingestRawPayload(payload, { companyId: COMPANY_ID, inboxId: INBOX_ID, tokenHash: 'fixture-proof' });


// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const INBOX_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';
const DOC_ID     = 'cccccccc-0000-0000-0000-000000000003';
const EVENT_ID   = 'dddddddd-0000-0000-0000-000000000004';
const WA_NUMBER  = '+27600000000';

function makePayload(overrides: Partial<TwilioInboundPayload> = {}): TwilioInboundPayload {
  return {
    From: 'whatsapp:+27611111111',
    To: `whatsapp:${WA_NUMBER}`,
    Body: '',
    NumMedia: '0',
    MessageSid: 'SM001',
    ...overrides,
  };
}

function makeInboxRow() {
  return { id: INBOX_ID, company_id: COMPANY_ID };
}

/** Set up a happy-path mock sequence for N media items. */
function mockMediaHappyPath(count: number) {
  // inbox lookup
  vi.mocked(sqlMock).mockResolvedValueOnce([makeInboxRow()] as never);
  for (let i = 0; i < count; i++) {
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: DOC_ID }] as never);  // INSERT captured_documents
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);                // UPDATE storage_bucket/path
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: EVENT_ID }] as never); // INSERT capture_events
  }
}

function makeMediaPayload(count: number, body = ''): TwilioInboundPayload {
  const p: TwilioInboundPayload = makePayload({ NumMedia: String(count), Body: body });
  for (let i = 0; i < count; i++) {
    p[`MediaUrl${i}`] = `https://api.twilio.com/media/MM00${i}`;
    p[`MediaContentType${i}`] = 'image/jpeg';
  }
  return p;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

function resetMocks() {
    vi.clearAllMocks();
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    // Restore storeMock default after clearAllMocks
    vi.mocked(storeMock).mockResolvedValue({
      bucket: 'captured-documents',
      path: 'company/doc-id',
      hash: 'abc123',
      size: 1024,
      documentId: DOC_ID,
    });
    vi.mocked(routeEventMock).mockResolvedValue(undefined);
    // Workstream D mocks: default to no open query
    vi.mocked(findOpenQueryMock).mockResolvedValue(null);
    vi.mocked(attachReplyMediaMock).mockResolvedValue(true);
    vi.mocked(markQueryRepliedMock).mockResolvedValue(undefined);
  }

export { sqlMock, storeMock, sha256Mock, routeEventMock, findOpenQueryMock, attachReplyMediaMock, markQueryRepliedMock, ingestTwilioPayload, ingestVerifiedPayload, COMPANY_ID, INBOX_ID, DOC_ID, EVENT_ID, WA_NUMBER, makePayload, makeInboxRow, mockMediaHappyPath, makeMediaPayload, resetMocks };
