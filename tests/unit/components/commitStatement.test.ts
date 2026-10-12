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

const line = { txId: 't', journalEntryId: 'j', label: '2026-09-08 R500.00', description: 'ACME', warnings: ['Line 1: cost centre OLD is inactive and was not applied — the line posts without it.'] };
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

  it('keeps only well-formed lines: objects, string label/description, string-array warnings', async () => {
    const ok = { txId: 't2', journalEntryId: 'j2', label: '2026-09-09 R 2,00', description: 'B', warnings: line.warnings };
    const r = await commit({ success: true, data: { status: 'imported', autoPost: { warnings: [
      null, 'x', 7, [], ok,
      { txId: 't3', label: 5, description: { a: 1 }, warnings: [line.warnings[0], 7, '', null] },
      { txId: 't4', label: '2026-09-10 R 3,00', warnings: 'Line 1: a string, not a list' },
      { txId: 't5', label: '2026-09-11 R 4,00', warnings: [] },
    ] } } });
    expect(r.dropped.map((d) => d.txId)).toEqual(['t3', 't2']); // sorted: '' label first... see the sort test
    expect(r.dropped.find((d) => d.txId === 't3')).toEqual({ txId: 't3', journalEntryId: undefined, label: '', description: null, warnings: [line.warnings[0]] });
    expect(r.dropped.find((d) => d.txId === 't2')).toEqual(ok);
  });

  it('puts the lines in a fixed order — by label (date first), then description — whatever order the server sent', async () => {
    const mk = (txId: string, label: string, description: string) => ({ txId, label, description, warnings: line.warnings });
    const r = await commit({ success: true, data: { status: 'imported', autoPost: { warnings: [
      mk('c', '2026-09-12 R 1,00', 'Z'), mk('a', '2026-09-08 R 5,00', 'B'), mk('b', '2026-09-08 R 5,00', 'A'),
    ] } } });
    expect(r.dropped.map((d) => d.txId)).toEqual(['b', 'a', 'c']);
  });

  it('returns the import\'s own data.warnings as strings, apart from the dropped picks', async () => {
    const r = await commit({ success: true, data: { status: 'imported', warnings: ['Auto-posting of imported outflows failed — still unposted.', 7, '', null, 'Row 3: bad date'], autoPost: { warnings: [] } } });
    expect(r.importWarnings).toEqual(['Auto-posting of imported outflows failed — still unposted.', 'Row 3: bad date']);
    expect(r.dropped).toEqual([]);
    expect((await commit({ success: true, data: { status: 'imported', warnings: 'no' } })).importWarnings).toEqual([]);
    expect((await commit({ success: true, data: { status: 'failed', reason: 'x', warnings: ['w'] } })).importWarnings).toEqual([]);
  });
});
