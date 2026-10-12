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
    expect((await commit({ success: true, data: { status: 'imported', autoPost: { warnings: [7, null, [], {}] } } })).dropped).toEqual([]);
    expect((await commit({ success: true, data: { status: 'imported' } })).dropped).toEqual([]);
  });

  it('never reads the import\'s own data.warnings as dropped picks', async () => {
    const r = await commit({ success: true, data: { status: 'imported', warnings: ['Auto-posting of imported outflows failed — still unposted.'] } });
    expect(r.dropped).toEqual([]);
  });

  it('keeps objects and bare sentences (not numbers, null or arrays), with string label/description and coerced string-array warnings', async () => {
    const ok = { txId: 't2', journalEntryId: 'j2', label: '2026-09-09 R 2,00', description: 'B', warnings: line.warnings };
    const r = await commit({ success: true, data: { status: 'imported', autoPost: { warnings: [
      null, 'x', 7, [], ok,
      { txId: 't3', label: 5, description: { a: 1 }, warnings: [line.warnings[0], 7, '', null] },
      { txId: 't4', label: '2026-09-10 R 3,00', warnings: 'Line 1: a string, not a list' },
      { txId: 't5', label: '2026-09-11 R 4,00', warnings: [] },
    ] } } });
    expect(r.dropped.map((d) => d.txId)).toEqual(['t2', 't4', undefined, 't3']); // the bare sentence 'x' is a line of its own; label-less lines sort last
    expect(r.dropped.find((d) => d.txId === 't3')).toEqual({ txId: 't3', journalEntryId: undefined, label: '', description: null, warnings: [line.warnings[0], '7'] });
    expect(r.dropped.find((d) => d.txId === 't4')!.warnings).toEqual(['Line 1: a string, not a list']); // coerced, not dropped
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
    expect(r.importWarnings).toEqual(['Auto-posting of imported outflows failed — still unposted.', '7', 'Row 3: bad date']);
    expect(r.dropped).toEqual([]);
    expect((await commit({ success: true, data: { status: 'imported', warnings: 'no' } })).importWarnings).toEqual(['no']);
    expect((await commit({ success: true, data: { status: 'failed', reason: 'x', warnings: ['w'] } })).importWarnings).toEqual([]);
  });

  it('coerces a wrong-shaped list instead of dropping it: a string, {error}/{message} objects, anything else as JSON', async () => {
    const r = (data: unknown) => commit({ success: true, data: { status: 'imported', ...(data as object) } });
    expect((await r({ warnings: 'Auto-post failed' })).importWarnings).toEqual(['Auto-post failed']);
    expect((await r({ warnings: [{ error: 'E1' }, { message: 'M1' }, { code: 7 }, 'plain', '', null] })).importWarnings)
      .toEqual(['E1', 'M1', '{"code":7}', 'plain']);
    expect((await r({ warnings: [] })).importWarnings).toEqual([]);
    const d = (await r({ autoPost: { warnings: [{ txId: 't', label: 'x', warnings: 'Line 1: a string' }] } })).dropped;
    expect(d.map((l) => l.warnings)).toEqual([['Line 1: a string']]);
  });

  it('lists each warning once per line', async () => {
    const d = (await commit({ success: true, data: { status: 'imported', autoPost: { warnings: [{ txId: 't', label: 'x', warnings: ['A', 'A', 'B'] }] } } })).dropped;
    expect(d[0]!.warnings).toEqual(['A', 'B']);
  });

  it('breaks ties on the line id, so the order never follows the server', async () => {
    const mk = (txId: string) => ({ txId, label: '2026-09-08 R 499,00', description: 'DEBIT ORDER', warnings: ['W'] });
    const ids = async (order: string[]) => (await commit({ success: true, data: { status: 'imported', autoPost: { warnings: order.map(mk) } } })).dropped.map((l) => l.txId);
    expect(await ids(['b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
    expect(await ids(['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('sorts a line with no label LAST, so the first drop keeps its bank-line wording', async () => {
    const d = (await commit({ success: true, data: { status: 'imported', autoPost: { warnings: [
      { txId: 'n', warnings: ['W'] }, { txId: 'a', label: '2026-09-12 R 1,00', warnings: ['W'] }, { txId: 'b', label: '2026-09-08 R 1,00', warnings: ['W'] },
    ] } } })).dropped;
    expect(d.map((l) => l.txId)).toEqual(['b', 'a', 'n']);
  });

  it('reads a lone object as a list of one, and a bare sentence as a line with only a warning', async () => {
    const one = (await commit({ success: true, data: { status: 'imported', autoPost: { warnings: { txId: 't', label: 'x', warnings: ['W'] } } } })).dropped;
    expect(one).toEqual([{ txId: 't', journalEntryId: undefined, label: 'x', description: null, warnings: ['W'] }]);
    const bare = (await commit({ success: true, data: { status: 'imported', autoPost: { warnings: ['Line 1: bare sentence', '  '] } } })).dropped;
    expect(bare).toEqual([{ txId: undefined, journalEntryId: undefined, label: '', description: null, warnings: ['Line 1: bare sentence'] }]);
  });

  it('a clean answer never reads "with problems": blank, {}, [], false and 0 are no warning', async () => {
    for (const w of ['', '   ', {}, [{}], [[]], ['  '], false, 0, [null, false]]) {
      expect((await commit({ success: true, data: { status: 'imported', warnings: w } })).importWarnings, JSON.stringify(w)).toEqual([]);
    }
  });
});
