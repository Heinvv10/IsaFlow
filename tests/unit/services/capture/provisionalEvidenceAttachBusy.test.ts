/**
 * D11 round 2: the manual evidence attach's claim answering `content_busy` (a fingerprint lock a peer holds past the
 * bounded wait) is `contended` (the route answers 503), not `refused` (400). Other claim refusals stay `refused`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/als', () => ({ als: { getStore: () => ({ client: { query: vi.fn().mockResolvedValue({}) } }) }, assertTxUsable: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn().mockResolvedValue([]), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/capture/captureRowLock', async (orig) => ({
  ...(await orig<object>()), lockCapturedDocumentForUpdate: vi.fn().mockResolvedValue({ id: 'd' }), claimCapturedDocumentForPosting: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTxLock', async (orig) => ({ ...(await orig<object>()), lockBankTransactionsInIdOrder: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalChainHead', async (orig) => ({ ...(await orig<object>()), findJournalChainHead: vi.fn().mockResolvedValue(null) }));
vi.mock('@/modules/accounting/services/gl/documentJournalClaimGuard', async (orig) => ({ ...(await orig<object>()), assertDocumentNotAlreadyPosted: vi.fn() }));

vi.mock('@/modules/accounting/services/shared/journalInForceAsAt', async (orig) => ({ ...(await orig<object>()), journalStandsUnbrokenFragment: () => '' }));
import { sql } from '@/lib/neon';
import { claimCapturedDocumentForPosting } from '@/modules/accounting/services/capture/captureRowLock';
import { attachDocumentToProvisional } from '@/modules/accounting/services/capture/provisionalEvidenceAttach';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
    const t = strings.join('?');
    return t.includes('needs_evidence') ? [{ needs_evidence: true, stands: true }] : [];
  }) as never);
});

describe('attachDocumentToProvisional: the claim refusal', () => {
  it('content_busy -> contended', async () => {
    vi.mocked(claimCapturedDocumentForPosting).mockResolvedValueOnce('content_busy');
    expect(await attachDocumentToProvisional('c', 'je', 'd')).toMatchObject({ kind: 'contended' });
  });
  it("being_read (the document's upload is still being read) -> reading, which the route answers 409", async () => {
    vi.mocked(claimCapturedDocumentForPosting).mockResolvedValueOnce('being_read');
    expect(await attachDocumentToProvisional('c', 'je', 'd')).toEqual({ kind: 'reading', message: 'This document is still being read.' });
  });
  it('not_read (the read failed or went silent) -> refused with the upload-again message (400)', async () => {
    vi.mocked(claimCapturedDocumentForPosting).mockResolvedValueOnce('not_read');
    expect(await attachDocumentToProvisional('c', 'je', 'd')).toEqual({ kind: 'refused', message: "This document's read did not finish — retry the read or upload the document again." });
  });
  it('content_posted stays refused', async () => {
    vi.mocked(claimCapturedDocumentForPosting).mockResolvedValueOnce('content_posted');
    expect(await attachDocumentToProvisional('c', 'je', 'd')).toMatchObject({ kind: 'refused' });
  });
});

describe('attachDocumentToProvisional: a bill raised from the slip held by another transaction', () => {
  it('-> contended before the claim or any write (a committed attach could never inherit on retry)', async () => {
    vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
      const t = strings.join('?');
      if (t.includes('needs_evidence') && t.includes('FOR UPDATE')) return [{ needs_evidence: true, stands: true }];
      if (t.includes('SELECT id FROM supplier_invoices')) return [{ id: 'bill-1' }];
      if (t.includes('SKIP LOCKED')) return []; // held by a peer
      if (t.includes('SELECT 1 FROM supplier_invoices')) return [{ '?column?': 1 }]; // but it exists
      return [];
    }) as never);
    expect(await attachDocumentToProvisional('c', 'je', 'd')).toMatchObject({ kind: 'contended' });
    expect(claimCapturedDocumentForPosting).not.toHaveBeenCalled();
    const writes = vi.mocked(sql).mock.calls.map(([s]) => (s as unknown as string[]).join('?')).filter((t) => /^\s*(UPDATE|INSERT|DELETE)\s/.test(t));
    expect(writes).toEqual([]);
  });
});
