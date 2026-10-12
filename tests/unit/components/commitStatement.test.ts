/**
 * commitStatement reads the route's answer ONCE: the status and the dropped
 * picks come from the same object, whether or not the body is enveloped in
 * `{ data }`, and the dropped picks are only those of an imported statement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/apiFetch', async (o) => ({ ...await o<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/lib/bulkUpload/folderTraversal', () => ({ readFileForUpload: vi.fn(async () => ({ csvContent: 'x', fileType: 'csv' })) }));
import { apiFetch } from '@/lib/apiFetch';
import { commitStatement } from '@/components/accounting/bank/commitStatement';

const line = { txId: 't', journalEntryId: 'j', label: '2026-09-08 R500.00', warnings: ['Line 1: cost centre OLD is inactive and was not applied — the line posts without it.'] };
const commit = (body: unknown, status = 200) => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(body), { status }));
  return commitStatement({ bankAccountId: 'b', bulkImportId: 'i', bulkSequence: 1, statementDate: '2026-09-30', applyBankRules: false,
    collected: { file: { name: 'a.csv' }, sizeBytes: 1 } as never });
};

describe('commitStatement', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('an enveloped imported answer: the status and the dropped lines', async () => {
    const r = await commit({ success: true, data: { status: 'imported', autoPost: { warnings: [line] } } });
    expect(r.data.status).toBe('imported');
    expect(r.dropped).toEqual([line]);
  });

  it('an un-enveloped imported answer gives the same', async () => {
    const r = await commit({ status: 'imported', transactionCount: 1, autoPost: { warnings: [line] } });
    expect(r.data.status).toBe('imported');
    expect(r.dropped).toEqual([line]);
  });

  it('nothing from a statement that was not imported, or from a malformed list', async () => {
    expect((await commit({ success: true, data: { status: 'failed', reason: 'x', autoPost: { warnings: [line] } } })).dropped).toEqual([]);
    expect((await commit({ success: true, data: { status: 'imported', autoPost: { warnings: 'no' } } })).dropped).toEqual([]);
    expect((await commit({ success: true, data: { status: 'imported' } })).dropped).toEqual([]);
  });

  it('never reads the import\'s own data.warnings as dropped picks', async () => {
    const r = await commit({ success: true, data: { status: 'imported', warnings: ['Auto-posting of imported outflows failed — still unposted.'] } });
    expect(r.dropped).toEqual([]);
  });
});
