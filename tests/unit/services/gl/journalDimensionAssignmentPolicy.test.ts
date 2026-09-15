import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import {
  assertJournalAnalysisDimensions,
} from '@/modules/accounting/services/gl/journalCostCentreValidation';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const COMPANY = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CC1 = '33333333-3333-4333-8333-333333333333';
const CC2 = '44444444-4444-4444-8444-444444444444';
const BU = '55555555-5555-4555-8555-555555555555';

const line = (dimensions: { cc1Id?: string; cc2Id?: string; buId?: string }) => [{
  glAccountId: ACCOUNT,
  debit: 1,
  credit: 0,
  ...dimensions,
}];

describe('journal analysis-dimension assignment policy', () => {
  beforeEach(() => mockSql.mockReset());

  it.each([
    ['inactive CC1', { cc1Id: CC1 }, [{ id: CC1, cc_type: 'cc1', is_active: false }],
      'CC1 must name an active CC1 cost centre in this company'],
    ['CC2 placed in CC1', { cc1Id: CC2 }, [{ id: CC2, cc_type: 'cc2', is_active: true }],
      'CC1 must name an active CC1 cost centre in this company'],
    ['CC1 placed in CC2', { cc2Id: CC1 }, [{ id: CC1, cc_type: 'cc1', is_active: true }],
      'CC2 must name an active CC2 cost centre in this company'],
  ])('refuses a new %s assignment', async (_label, dimensions, rows, message) => {
    mockSql.mockResolvedValueOnce(rows);
    await expect(assertJournalAnalysisDimensions(COMPANY, line(dimensions)))
      .rejects.toThrow(message);
  });

  it('refuses a new inactive business-unit assignment', async () => {
    mockSql.mockResolvedValueOnce([{ id: BU, is_active: false }]);
    await expect(assertJournalAnalysisDimensions(COMPANY, line({ buId: BU })))
      .rejects.toThrow('Business unit must be active and belong to this company');
  });

  it.each([0, false])('refuses malformed falsy CC1 input (%j)', async (cc1Id) => {
    await expect(assertJournalAnalysisDimensions(
      COMPANY,
      line({ cc1Id: cc1Id as unknown as string }),
    )).rejects.toThrow('CC1 must name an active CC1 cost centre in this company');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('preserves owned inactive references in historical-copy mode', async () => {
    mockSql
      .mockResolvedValueOnce([
        { id: CC1, cc_type: 'cc1', is_active: false },
        { id: CC2, cc_type: 'cc2', is_active: false },
      ])
      .mockResolvedValueOnce([{ id: BU, is_active: false }]);
    await expect(assertJournalAnalysisDimensions(
      COMPANY,
      line({ cc1Id: CC1, cc2Id: CC2, buId: BU }),
      'historical-copy',
    )).resolves.toBeUndefined();
  });

  it('locks validated rows against concurrent deactivation until assignment commits', async () => {
    mockSql
      .mockResolvedValueOnce([{ id: CC1, cc_type: 'cc1', is_active: true }])
      .mockResolvedValueOnce([{ id: BU, is_active: true }]);
    await assertJournalAnalysisDimensions(COMPANY, line({ cc1Id: CC1, buId: BU }));
    const statements = mockSql.mock.calls.map((call) =>
      (call[0] as readonly string[]).join(' '));
    expect(statements).toHaveLength(2);
    expect(statements.every((statement) => /FOR SHARE/i.test(statement))).toBe(true);
  });
});
