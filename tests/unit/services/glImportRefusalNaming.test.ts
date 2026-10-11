/**
 * GL import: which row, and which words, a dimension refusal is reported with
 * (PR #688 final round). placeRowCentres named `rows.find(r => r.costCentre)`
 * and said "cost centre … cannot be used" for every PreWriteDimensionRefusal
 * that was not a pick refusal — the wrong row when an earlier row carried a
 * centre, and the wrong cause for a refusal that is not about a centre. It
 * names the row at the refusal's `lineIndex` with the refusal's own message,
 * and the group when the refusal is about no single line.
 *
 * The dimension check is replaced here so each kind of refusal can be raised
 * on a chosen line; the real one runs in cost-centre-pick-writers.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() }),
  withTransaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(), postJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionPolicy', async (orig) => ({
  ...(await orig<object>()), assertNewJournalDimensions: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { assertNewJournalDimensions } from '@/modules/accounting/services/gl/dimensions/dimensionPolicy';
import { PreWriteDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { importJournalEntries, ImportValidationError } from '@/modules/accounting/services/gl/glImportExecuteService';

const sqlMock = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const HT = 'cccccccc-0000-4000-8000-000000000001';
const PI = 'cccccccc-0000-4000-8000-000000000002';
const UNT = 'cccccccc-0000-4000-8000-000000000003';
const CENTRES = [
  { code: 'HT', id: HT, cc_type: 'cc1', is_active: true }, { code: 'PI', id: PI, cc_type: 'cc2', is_active: true },
  { code: 'UNT', id: UNT, cc_type: null, is_active: true },
];
const ROWS = [
  { date: '2026-08-13', reference: 'REF1', description: 'fine', accountCode: '6000', debit: 60, credit: 0, costCentre: 'HT' },
  { date: '2026-08-13', reference: 'REF1', description: 'under an inactive fno', accountCode: '6000', debit: 40, credit: 0, costCentre: 'PI' },
  { date: '2026-08-13', reference: 'REF1', description: 'ap', accountCode: '2100', debit: 0, credit: 100 },
];
const run = (rows = ROWS) => importJournalEntries('co', rows, 'user', true).then(() => null, (e: unknown) => e as Error);

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockImplementation(((strings: TemplateStringsArray, _co: unknown, ids?: string[]) => {
    const text = Array.isArray(strings) ? strings.join('') : '';
    if (text.includes('FROM gl_accounts')) return Promise.resolve([{ account_code: '6000', id: 'a-exp' }, { account_code: '2100', id: 'a-ap' }]);
    if (text.includes('FROM cost_centres')) return Promise.resolve(Array.isArray(ids) ? CENTRES.filter((c) => ids.includes(c.id)) : CENTRES);
    return Promise.resolve([]);
  }) as never);
});

describe('GL import: a dimension refusal names its own row', () => {
  it('the row at lineIndex, with the refusal\'s own message — not the first row that has a centre', async () => {
    vi.mocked(assertNewJournalDimensions).mockRejectedValue(
      new PreWriteDimensionRefusal('CC1 must name an active CC1 cost centre in this company', 1));
    const err = await run();
    expect(err).toBeInstanceOf(ImportValidationError);
    expect(err!.message).toBe('Import row "under an inactive fno" (2026-08-13): CC1 must name an active CC1 cost centre in this company');
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('a refusal that is not about a cost centre is not called one, and loses its own "Line N:" for the row\'s name', async () => {
    vi.mocked(assertNewJournalDimensions).mockRejectedValue(
      new PreWriteDimensionRefusal('Line 3: Business unit must be active and belong to this company', 2));
    expect((await run())!.message).toBe('Import row "ap" (2026-08-13): Business unit must be active and belong to this company');
  });

  it('a refusal about no single line names the group', async () => {
    vi.mocked(assertNewJournalDimensions).mockRejectedValue(
      new PreWriteDimensionRefusal('A settlement, receipt, transfer or VAT payment carries no CC1/CC2/BU.'));
    expect((await run())!.message).toBe('Import group "REF1" (2026-08-13): A settlement, receipt, transfer or VAT payment carries no CC1/CC2/BU.');
    expect((await run(ROWS.map(({ reference: _r, ...row }) => row)))!.message).toMatch(/^Import group \(2026-08-13\): A settlement/);
  });

  it('a pick that cannot be placed still names its row and its code', async () => {
    const err = await run([{ ...ROWS[2]!, credit: 40 }, { ...ROWS[1]!, description: 'untyped', costCentre: 'UNT' }]);
    expect(err!.message).toBe(
      'Import row "untyped" (2026-08-13): cost centre "UNT" cannot be used — CC1 must name an active CC1 cost centre in this company');
    expect(assertNewJournalDimensions).not.toHaveBeenCalled();
  });

  it('anything else propagates untouched', async () => {
    const down = Object.assign(new Error('connection terminated'), { code: '57P01' });
    vi.mocked(assertNewJournalDimensions).mockRejectedValue(down);
    expect(await run()).toBe(down);
  });
});
