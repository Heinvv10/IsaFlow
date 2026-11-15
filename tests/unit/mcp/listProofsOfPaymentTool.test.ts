/**
 * list_proofs_of_payment — the tool's own contract: argument refusals before any query, filters passed through, the
 * page clamp and the reply shape. The query (tenant isolation, filters, pending vs outcomes, ILIKE escaping, summary
 * over the whole filter) is pinned on real PostgreSQL in tests/integration/list-proofs-of-payment.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/capture/pop/popListService', () => ({ listProofsOfPayment: vi.fn() }));

import { listProofsOfPayment, type PopListPage } from '@/modules/accounting/services/capture/pop/popListService';
import { listProofsOfPaymentTool, PROOFS_OF_PAYMENT_MAX_LIMIT } from '@/lib/mcp/tools/listProofsOfPayment';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const ctx = { companyId: COMPANY, userId: 'u-1', scopes: ['read:reports'] } as McpToolContext;
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const zeroSummary = {
  byMatch: { attached: 0, ambiguous: 0, not_found: 0, refused: 0, pending: 0 },
  byArchive: { archived: 0, too_large: 0, failed: 0, pending: 0 },
};
const empty: PopListPage = { rows: [], total: 0, summary: zeroSummary, archiveConfigured: true };
const call = (args: Record<string, unknown>) => listProofsOfPaymentTool.handler(args, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listProofsOfPayment).mockResolvedValue(empty);
});

describe('list_proofs_of_payment', () => {
  it('is a read tool on read:reports with a closed schema', () => {
    expect(listProofsOfPaymentTool.write).toBe(false);
    expect(listProofsOfPaymentTool.scope).toBe('read:reports');
    expect((listProofsOfPaymentTool.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it('refuses a status outside the enums before querying (the schema enum is documentation only)', async () => {
    expect(text(await call({ match_status: 'matched' })))
      .toBe('match_status must be one of: attached, ambiguous, not_found, refused, pending, unmatched');
    expect(text(await call({ archive_status: 'uploaded' })))
      .toBe('archive_status must be one of: archived, too_large, failed, pending');
    expect(listProofsOfPayment).not.toHaveBeenCalled();
  });

  it('refuses a reversed range, an impossible date and a bad offset before querying', async () => {
    expect(text(await call({ date_from: '2026-05-01', date_to: '2026-04-01' }))).toBe('date_from must not be after date_to');
    expect(text(await call({ date_from: '2026-02-31' }))).toBe('invalid date_from');
    expect(text(await call({ date_to: 'yesterday' }))).toBe('invalid date_to');
    expect((await call({ offset: -1 })).isError).toBe(true);
    expect(listProofsOfPayment).not.toHaveBeenCalled();
  });

  it('passes every filter through for the token\'s company, with the default page', async () => {
    await call({
      match_status: 'unmatched', archive_status: 'failed', date_from: '2026-11-01', date_to: '2026-11-14', beneficiary: '  Mabehla ',
    });
    expect(listProofsOfPayment).toHaveBeenCalledWith(COMPANY, {
      matchStatus: 'unmatched', archiveStatus: 'failed', dateFrom: '2026-11-01', dateTo: '2026-11-14',
      beneficiary: 'Mabehla', limit: 50, offset: 0,
    });
  });

  it('sends no filter as null', async () => {
    await call({});
    expect(listProofsOfPayment).toHaveBeenCalledWith(COMPANY, {
      matchStatus: null, archiveStatus: null, dateFrom: null, dateTo: null, beneficiary: null, limit: 50, offset: 0,
    });
  });

  it('clamps a limit past the maximum', async () => {
    await call({ limit: 10_000, offset: 20 });
    expect(vi.mocked(listProofsOfPayment).mock.calls[0]![1]).toMatchObject({ limit: PROOFS_OF_PAYMENT_MAX_LIMIT, offset: 20 });
  });

  it('answers each POP with its match and archive status, the summary and next_offset', async () => {
    const row = {
      popId: 'p1', transactionNumber: '80ABC-01', paymentDate: '2026-11-10', amount: 3000, beneficiary: 'Tintswalo G Mabehla',
      payerProfile: 'EXAMPLE TRADING PTY LTD', capturedDocumentId: 'd1', createdAt: '2026-11-10T08:00:00.000Z',
      match: { status: 'ambiguous' as const, bankTransactionId: null, candidateBankTransactionIds: ['b1', 'b2'], refusal: null, checkedAt: '2026-11-11T08:00:00.000Z' },
      archive: { status: 'pending' as const, webUrl: null, path: null, settledAt: null, attempts: 2, tries: 3, lastAttemptAt: '2026-11-11T09:00:00.000Z', lastError: 'graph 404' },
    };
    const summary = { byMatch: { ...zeroSummary.byMatch, ambiguous: 5 }, byArchive: { ...zeroSummary.byArchive, pending: 5 } };
    vi.mocked(listProofsOfPayment).mockResolvedValueOnce({ rows: [row, row], total: 5, summary, archiveConfigured: false });
    const first = JSON.parse(text(await call({ limit: 2 })));
    expect(first.next_offset).toBe(2);
    expect(first.total).toBe(5);
    expect(first.archive_configured).toBe(false);
    expect(first.summary).toEqual({ by_match_status: summary.byMatch, by_archive_status: summary.byArchive });
    expect(first.proofs_of_payment[0]).toEqual({
      pop_id: 'p1', transaction_number: '80ABC-01', payment_date: '2026-11-10', amount: 3000, beneficiary: 'Tintswalo G Mabehla',
      payer_profile: 'EXAMPLE TRADING PTY LTD', captured_document_id: 'd1', created_at: '2026-11-10T08:00:00.000Z',
      match: { status: 'ambiguous', bank_transaction_id: null, candidate_bank_transaction_ids: ['b1', 'b2'], refusal: null, checked_at: '2026-11-11T08:00:00.000Z' },
      archive: {
        status: 'pending', web_url: null, path: null, settled_at: null, attempts: 2, tries: 3,
        last_attempt_at: '2026-11-11T09:00:00.000Z', last_error: 'graph 404',
      },
    });

    vi.mocked(listProofsOfPayment).mockResolvedValueOnce({ rows: [row], total: 5, summary, archiveConfigured: false });
    expect(JSON.parse(text(await call({ limit: 2, offset: 4 }))).next_offset).toBeNull();
  });
});
