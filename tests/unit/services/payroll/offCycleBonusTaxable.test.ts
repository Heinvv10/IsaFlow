/**
 * Wave 6 OC, review #1679 Codex of 7630d9379: a bonus is costed only on a TAXABLE 3605 earning. A 3605 marked not taxable
 * adds the bonus to gross pay and nothing to PAYE, so a component changed after the run was created is refused at
 * calculation (409), never costed (creation refuses it too: w6-oc-gates).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => ({ bonus: [] as Array<Record<string, unknown>> }));
// The bonus inputs; the final-regular-run check (gate item 2 on 06c106a94d) finds every employee on it.
vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(async (strings: readonly string[]) => (strings.join('?').includes('NOT EXISTS') ? [] : rows.bonus)),
    { unsafe: (t: string) => t }),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunRegularDirective', () => ({ loadRegularPayDirectives: vi.fn(async () => new Map()) }));
vi.mock('@/modules/accounting/services/payroll/payrollOffCycleMonthRead', () => ({ loadMonthEarlierLines: vi.fn(async () => new Map()) }));

import { prepareOffCycleComponents } from '@/modules/accounting/services/payroll/payrollOffCyclePopulation';
import { OffCycleRunRefusedError } from '@/modules/accounting/services/payroll/payrollOffCycleRun';
import type { PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const employee = { id: 'e1', firstName: 'Ruby', lastName: 'Rubric' } as PayrollEmployee;
const bonusRow = (over: Record<string, unknown> = {}) => ({
  employee_id: 'e1', amount: '10000', id: 'c1', name: 'Annual bonus', sars_source_code: '3605 ', component_type: 'earning',
  is_taxable: true, is_uif_applicable: true, is_sdl_applicable: true, ...over,
});
const prepare = () => prepareOffCycleComponents({ companyId: 'co', runId: 'run', period: { year: 2026, month: 3 }, reason: 'bonus', employees: [employee] });

describe('the bonus component at calculation', () => {
  beforeEach(() => { rows.bonus = []; });
  it('a taxable 3605 earning is costed', async () => {
    rows.bonus = [bonusRow()];
    const [line] = await prepare();
    expect(line!.components).toEqual([expect.objectContaining({ amount: 10_000, component: expect.objectContaining({ isTaxable: true, sarsSourceCode: '3605 ' }) })]);
  });
  it.each([
    ['marked not taxable', { is_taxable: false }],
    ['moved off 3605', { sars_source_code: '3601' }],
    ['made a deduction', { component_type: 'deduction' }],
  ])('a component %s since creation: refused (409)', async (_label, over) => {
    rows.bonus = [bonusRow(over)];
    const err = await prepare().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OffCycleRunRefusedError);
    expect(err).toMatchObject({ status: 409, message: expect.stringMatching(/Ruby Rubric's bonus component "Annual bonus" is no longer a taxable annual-payment earning/) });
  });
});
