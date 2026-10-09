/**
 * project_profitability reads the CC2 (project) dimension, not the legacy
 * project_id that no line on these books carries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  getProjectProfitability,
  getProjectTaggingCoverage,
} from '@/modules/accounting/services/reports/projectProfitabilityService';

const CO = '11111111-1111-4111-8111-111111111111';
const P1 = 'cccccccc-0000-4000-8000-000000000001';
const P2 = 'cccccccc-0000-4000-8000-000000000002';

const r = (project: string, code: string | null, acc: string, type: string, debit: number, credit: number) => ({
  project_id: project, project_code: code, project_name: code ? `${code} name` : null,
  account_code: acc, account_name: acc, account_type: type, total_debit: debit, total_credit: credit,
});

beforeEach(() => sqlMock.mockReset());

describe('getProjectProfitability — keyed on cc2_id', () => {
  it('queries cc2_id, joins the cost centre within the company, and builds one report per project in one query', async () => {
    sqlMock.mockResolvedValue([
      r(P1, 'FT-MOH2', '4000', 'revenue', 0, 1000),
      r(P1, 'FT-MOH2', '5000', 'expense', 400, 0),
      r(P2, null, '5000', 'expense', 50, 0),
    ]);
    const reports = await getProjectProfitability(CO, '2026-04-01', '2026-04-30');
    expect(sqlMock).toHaveBeenCalledTimes(1);
    const text = (sqlMock.mock.calls[0]![0] as TemplateStringsArray).join('$');
    expect(text).toMatch(/jl\.cc2_id IS NOT NULL/);
    expect(text).toMatch(/LEFT JOIN cost_centres cc ON cc\.id = jl\.cc2_id AND cc\.company_id = jl\.company_id/);
    expect(text).not.toMatch(/project_id IS NOT NULL/);

    expect(reports.map((x) => x.projectId)).toEqual([P1, P2]);
    expect(reports[0]).toMatchObject({ projectName: 'FT-MOH2 — FT-MOH2 name', revenue: 1000, costs: 400, profit: 600, margin: 60 });
    expect(reports[1]).toMatchObject({ projectName: 'Unknown Project', costs: 50, profit: -50 });
  });

  it('coverage counts lines with and without a CC2', async () => {
    sqlMock.mockResolvedValue([{ tagged_lines: 7, untagged_lines: 3, untagged_amount: '12.50', posted_through: null }]);
    const c = await getProjectTaggingCoverage(CO, '2026-04-01', '2026-04-30');
    const text = (sqlMock.mock.calls[0]![0] as TemplateStringsArray).join('$');
    expect(text).toMatch(/WHERE jl\.cc2_id IS NOT NULL/);
    expect(c).toEqual({ taggedLines: 7, untaggedLines: 3, untaggedAmount: 12.5, postedThrough: null });
  });
});
