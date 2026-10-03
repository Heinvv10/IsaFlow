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
  it('content_posted stays refused', async () => {
    vi.mocked(claimCapturedDocumentForPosting).mockResolvedValueOnce('content_posted');
    expect(await attachDocumentToProvisional('c', 'je', 'd')).toMatchObject({ kind: 'refused' });
  });
});
