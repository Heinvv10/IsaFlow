/**
 * The custom report builder's gl_transactions source named `jl.cost_centre_id`
 * (no such column — a 42703 on every run that selected it) and the wrong
 * gl_accounts / gl_journal_lines column names. The dimension fields now read
 * the canonical cc1/cc2/bu through tenant-scoped joins.
 */
import { describe, expect, it } from 'vitest';
import { getAvailableFields, getBaseQuery, getFieldDef } from '@/modules/accounting/services/reports/customReportFieldDefs';

describe('custom report gl_transactions fields', () => {
  it('no field references a column gl_journal_lines or gl_accounts does not have', () => {
    const exprs = getAvailableFields('gl_transactions').map((f) => f.sqlExpr);
    for (const bad of ['cost_centre_id', 'debit_amount', 'credit_amount', 'a.code', 'a.name', 'a.type']) {
      expect(exprs.some((e) => e === bad || e.endsWith(`.${bad}`) || e === bad), bad).toBe(false);
    }
  });

  it('exposes CC1, CC2 and BU codes through joins scoped to the entry company', () => {
    expect(getFieldDef('gl_transactions', 'cost_centre')?.sqlExpr).toBe('cc1.code');
    expect(getFieldDef('gl_transactions', 'project_cc2')?.sqlExpr).toBe('cc2.code');
    expect(getFieldDef('gl_transactions', 'business_unit')?.sqlExpr).toBe('bu.code');
    const q = getBaseQuery('gl_transactions');
    expect(q).toMatch(/LEFT JOIN cost_centres cc1 ON cc1\.id = jl\.cc1_id AND cc1\.company_id = je\.company_id/);
    // CC1 is cc1_id alone: the legacy cost_center_id is read by no report (PR #688 round 2).
    expect(q).not.toMatch(/cost_center_id/);
    expect(q).toMatch(/LEFT JOIN cost_centres cc2 ON cc2\.id = jl\.cc2_id AND cc2\.company_id = je\.company_id/);
    expect(q).toMatch(/LEFT JOIN business_units bu ON bu\.id = jl\.bu_id AND bu\.company_id = je\.company_id/);
  });
});
