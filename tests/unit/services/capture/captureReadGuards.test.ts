/**
 * The service-level places that must know an upload is still being read: the document lock reads the read columns,
 * the lifecycle gate refuses confirm (not reject), the manual provisional attach answers 'reading', and the journal
 * link picker does not offer a document that has no extraction yet.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn(), release: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/als', () => ({ als: { getStore: () => ({ client: { query: m.query } }) }, assertTxUsable: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/capture/capturePostingClaimRelease', () => ({ releaseUnpostedCaptureClaim: m.release }));
vi.mock('@/modules/accounting/services/bank/bankTxLock', async (orig) => ({ ...(await orig<object>()), lockBankTransactionsInIdOrder: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalChainHead', async (orig) => ({ ...(await orig<object>()), findJournalChainHead: vi.fn().mockResolvedValue(null) }));
vi.mock('@/modules/accounting/services/shared/journalInForceAsAt', async (orig) => ({ ...(await orig<object>()), journalStandsUnbrokenFragment: () => '', journalStandsFragment: () => '' }));

import { lockCapturedDocumentForUpdate } from '@/modules/accounting/services/capture/captureRowLock';
import { releaseClaimForLifecycleAction } from '@/modules/accounting/services/capture/captureLifecycleGate';
import { attachDocumentToProvisional } from '@/modules/accounting/services/capture/provisionalEvidenceAttach';
import { listLinkableDocuments } from '@/modules/accounting/services/gl/journalDocumentLinkService';
import { STILL_BEING_READ } from '@/modules/accounting/services/capture/captureReadState';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
let docRow: Record<string, unknown> | null;
const texts: string[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  texts.length = 0;
  docRow = { status: 'pending', posted_at: null, read_state: 'reading', read_heartbeat_at: null, created_at: minutesAgo(1) };
  m.query.mockResolvedValue({});
  m.release.mockResolvedValue(true);
  m.sql.mockImplementation(async (strings: TemplateStringsArray) => {
    const t = strings.join('?').replace(/\s+/g, ' ');
    texts.push(t);
    if (t.includes('FROM captured_documents') && t.includes('FOR UPDATE')) return docRow ? [docRow] : [];
    if (t.includes('needs_evidence')) return [{ needs_evidence: true, stands: true }];
    return [];
  });
});

describe('lockCapturedDocumentForUpdate', () => {
  it('reads the read columns with the lock', async () => {
    await lockCapturedDocumentForUpdate('c', 'd');
    const t = texts.find((x) => x.includes('FOR UPDATE'))!;
    for (const col of ['read_state', 'read_heartbeat_at', 'created_at']) expect(t).toContain(col);
    expect(t).toContain('company_id');
  });
});

describe('releaseClaimForLifecycleAction', () => {
  it("answers 'reading' for confirm while the document is being read", async () => {
    expect(await releaseClaimForLifecycleAction('c', 'd', 'confirm')).toBe('reading');
    expect(m.release).not.toHaveBeenCalled();
  });
  it('lets reject through while the document is being read', async () => {
    expect(await releaseClaimForLifecycleAction('c', 'd', 'reject')).toBe('ok');
  });
  it('lets confirm through once the read is stale or done', async () => {
    docRow = { ...docRow, created_at: minutesAgo(30) };
    expect(await releaseClaimForLifecycleAction('c', 'd', 'confirm')).toBe('ok');
    docRow = { ...docRow, read_state: 'done', created_at: minutesAgo(1) };
    expect(await releaseClaimForLifecycleAction('c', 'd', 'confirm')).toBe('ok');
  });
  it("still answers 'missing' for no row", async () => {
    docRow = null;
    expect(await releaseClaimForLifecycleAction('c', 'd', 'confirm')).toBe('missing');
  });
});

describe('attachDocumentToProvisional', () => {
  it("answers 'reading' with the refusal message for a document being read", async () => {
    expect(await attachDocumentToProvisional('c', 'je', 'd')).toEqual({ kind: 'reading', message: STILL_BEING_READ });
  });
  it('does not answer reading for a stale read (it goes on to its other checks)', async () => {
    docRow = { ...docRow, created_at: minutesAgo(30) };
    expect(await attachDocumentToProvisional('c', 'je', 'd')).not.toMatchObject({ kind: 'reading' });
  });
});

describe('listLinkableDocuments', () => {
  it('leaves out documents being read, by the same 5-minute staleness the row state uses', async () => {
    await listLinkableDocuments('c');
    const t = texts.find((x) => x.includes('FROM captured_documents cd'))!;
    expect(t).toContain("cd.read_state = 'reading'");
    expect(t).toContain('COALESCE(cd.read_heartbeat_at, cd.created_at) >');
    expect(m.sql.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes('FROM captured_documents cd'))!.slice(1)).toContain(5);
  });
});
