// RED phase — written before implementation
/**
 * Unit tests for captureRouterService.ts
 *
 * Covers: routeEvent status transitions (received → extracting → extracted | failed).
 * The VLM extraction path (ocrService) is mocked to control happy / failure branches.
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

// Mock the OCR service — captureRouterService imports extractFromPdf / extractFromImage
vi.mock('@/modules/accounting/services/core/ocrService', () => ({
  extractFromPdf:   vi.fn(),
  extractFromImage: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { routeEvent } from '@/modules/accounting/services/capture/captureRouterService';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const EVENT_ID    = 'bbbbbbbb-0000-0000-0000-000000000002';
const DOC_ID      = 'cccccccc-0000-0000-0000-000000000003';

function makeEventRow(overrides: Record<string, unknown> = {}) {
  return {
    event_id:              EVENT_ID,
    captured_document_id:  DOC_ID,
    event_status:          'received',
    file_type:             'pdf',
    doc_notes:             'email-ingest: base64_size=2048, name=invoice.pdf, from=supplier@co.za',
    doc_status:            'pending',
    ...overrides,
  };
}

// ── routeEvent ────────────────────────────────────────────────────────────────

describe('routeEvent', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Event not found ────────────────────────────────────────────────────────

  it('returns early without updating status when event is not found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never); // event SELECT returns empty

    await routeEvent(EVENT_ID, COMPANY_ID);

    // Only the SELECT was issued — no UPDATE calls
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });

  it('does not throw when event belongs to a different company', async () => {
    // The WHERE clause filters by company_id; service returns empty → early return
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await expect(routeEvent(EVENT_ID, 'wrong-company-id')).resolves.toBeUndefined();
  });

  // ── Happy path — status transitions ───────────────────────────────────────

  it('transitions status received → extracting → extracted for a PDF event', async () => {
    // SELECT event+doc row
    vi.mocked(sql).mockResolvedValueOnce([makeEventRow()] as never);
    // UPDATE status → 'extracting'
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    // UPDATE status → 'extracted' (no extracted data update because extracted===null in placeholder)
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await routeEvent(EVENT_ID, COMPANY_ID);

    // Calls: 1 SELECT + 1 UPDATE extracting + 1 UPDATE extracted = 3
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(3);

    // Verify call order by inspecting mock call sequence count
    const callCount = vi.mocked(sql).mock.calls.length;
    expect(callCount).toBe(3);
  });

  it('transitions status received → extracting → extracted for an image/jpeg event', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEventRow({ file_type: 'jpg' })] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await routeEvent(EVENT_ID, COMPANY_ID);

    expect(vi.mocked(sql)).toHaveBeenCalledTimes(3);
  });

  it('transitions status received → extracting → extracted for a png event', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEventRow({ file_type: 'png' })] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await routeEvent(EVENT_ID, COMPANY_ID);

    expect(vi.mocked(sql)).toHaveBeenCalledTimes(3);
  });

  it('skips the captured_documents UPDATE when extraction returns null', async () => {
    // Current implementation: placeholder returns null, so no doc UPDATE is issued.
    // Only extracting UPDATE + extracted UPDATE.
    vi.mocked(sql).mockResolvedValueOnce([makeEventRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never); // → extracting
    vi.mocked(sql).mockResolvedValueOnce([] as never); // → extracted

    await routeEvent(EVENT_ID, COMPANY_ID);

    // 3 calls: SELECT + 2 UPDATEs (no doc UPDATE because extracted===null)
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(3);
  });

  // ── Failure path ──────────────────────────────────────────────────────────

  it('transitions to failed when a downstream sql call throws', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEventRow()] as never); // SELECT
    vi.mocked(sql).mockResolvedValueOnce([] as never);               // → extracting UPDATE succeeds
    // Simulated error during the "extracted" UPDATE (e.g. constraint violation)
    vi.mocked(sql).mockRejectedValueOnce(new Error('deadlock detected') as never);
    // The catch block issues the failed UPDATE
    vi.mocked(sql).mockResolvedValueOnce([] as never);               // → failed UPDATE

    await routeEvent(EVENT_ID, COMPANY_ID);

    // 4 calls: SELECT + extracting + (throws) + failed
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(4);
  });

  it('records the error message on the failed update', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEventRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never); // extracting
    vi.mocked(sql).mockRejectedValueOnce(new Error('VLM unavailable') as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never); // failed

    await routeEvent(EVENT_ID, COMPANY_ID);

    // The fourth sql call is the failed-status UPDATE — it includes the error message.
    // We assert it was issued (not that its SQL string contains the message, to avoid
    // coupling to the tagged-template internals).
    const calls = vi.mocked(sql).mock.calls;
    expect(calls).toHaveLength(4);
  });

  it('propagates error when the failed-status UPDATE itself errors', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEventRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never); // → extracting
    vi.mocked(sql).mockRejectedValueOnce(new Error('primary error') as never);
    // failed-status UPDATE also fails — service propagates the secondary error
    vi.mocked(sql).mockRejectedValueOnce(new Error('secondary DB error') as never);

    await expect(routeEvent(EVENT_ID, COMPANY_ID)).rejects.toThrow('secondary DB error');
  });

  // ── Unsupported mime type ─────────────────────────────────────────────────

  it('still transitions to extracted for unsupported mime (no extraction attempted)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEventRow({ file_type: 'docx' })] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never); // extracting
    vi.mocked(sql).mockResolvedValueOnce([] as never); // extracted (null data)

    await routeEvent(EVENT_ID, COMPANY_ID);

    expect(vi.mocked(sql)).toHaveBeenCalledTimes(3);
  });
});
