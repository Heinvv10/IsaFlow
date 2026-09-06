/**
 * `getFinancialFigures` joins `gl_accounts` to classify every posted line by
 * account type + subtype. Without `ga.company_id` bound to the same company
 * as the journal, the join can walk into another tenant's chart of accounts.
 *
 * That is not hypothetical: Brightsphere's JE-2026-00002 posts a R450 debit
 * to account 1140, which belongs to Dotbiz, not Brightsphere. Two paths read
 * that line through two different lenses —
 *
 *   - The share pack (`sharedPackService` → `getFinancialFigures`) runs on
 *     the pool connection, a superuser that bypasses RLS. Unscoped, the join
 *     succeeds against Dotbiz's account 1140 and classifies the R450 as a
 *     Brightsphere asset.
 *   - The authenticated page (`getBalanceSheet`, under RLS as `app_user`)
 *     cannot see a row of `gl_accounts` it does not own, so the INNER JOIN
 *     drops the line entirely — the page is R450 short on the asset side.
 *
 * One tenant, one line, two different wrong answers depending on which door
 * you read it through. The fix is one additive predicate — `AND
 * ga.company_id = <company>` — which makes both paths drop the line for the
 * same reason: it does not belong to this tenant's chart of accounts either
 * way.
 *
 * Pure mocked assertions only — the real-Postgres proof that the two paths
 * now AGREE on Brightsphere's actual data lives in
 * tests/integration/financialFiguresScoping.int.test.ts, which needs a real
 * DATABASE_URL. This file must stay DB-free: it runs unconditionally as part
 * of `bun run test:unit`, in CI, where no live database is guaranteed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn() };
});

const broughtForwardMock = vi.fn();
vi.mock('@/modules/accounting/services/gl/trialBalanceBasis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/trialBalanceBasis')>()),
  getRetainedEarningsBroughtForward: (...a: unknown[]) => broughtForwardMock(...a),
}));

import { sql } from '@/lib/neon';
import { getFinancialFigures } from '@/modules/accounting/services/gl/financialFiguresService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

/**
 * The SQL text the tagged template produced, with comments stripped so a
 * clause moved into `--` cannot fool a `toMatch` assertion. Same approach as
 * tests/unit/services/gl/financialFiguresService.test.ts.
 */
function lastQueryText(): string {
  const strings = mockSql.mock.calls[0]![0] as unknown as string[];
  return strings
    .join(' ? ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

beforeEach(() => {
  mockSql.mockReset();
  broughtForwardMock.mockReset();
  broughtForwardMock.mockResolvedValue(0);
});

describe('getFinancialFigures — gl_accounts join is scoped to the company', () => {
  it('binds ga.company_id to the same company parameter as the journal tables', async () => {
    mockSql.mockResolvedValue([]);
    await getFinancialFigures(COMPANY, '2026-03-01', '2026-08-31');

    const text = lastQueryText();
    expect(text).toMatch(/JOIN gl_accounts ga ON ga\.id = jl\.gl_account_id AND ga\.company_id = .*::UUID/);

    // Every bound company-id parameter — je.company_id, jl.company_id, and
    // the new ga.company_id — must be the SAME company, not merely present.
    const params = mockSql.mock.calls[0]!.slice(1) as unknown[];
    const companyParams = params.filter((p) => p === COMPANY);
    expect(companyParams.length).toBeGreaterThanOrEqual(3);
    expect(companyParams.every((p) => p === COMPANY)).toBe(true);
  });
});
