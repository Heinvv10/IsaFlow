/**
 * Payroll labour lines carry the employee's cost centre in CC1 (Hein,
 * 2026-11-02: "post with CC1", so budgets by CC1 get real payroll actuals).
 *
 * The split aggregates by (expense account, CC1), not by account alone: the
 * cost-centre → account mapping still picks the account exactly as before, and
 * the centre itself rides on the line. A centre the ledger would refuse as a
 * CC1 (inactive, or a CC2 project) is not in `taggableCostCentres`: its labour
 * posts untagged on the same account.
 */
import { describe, it, expect } from 'vitest';
import { buildLabourDebitLines, type BuildLabourDebitInput } from '@/modules/accounting/services/payroll/payrollJournalSplitBuilder';

const DEFAULT_ACCT = 'acct-5200';
const ADMIN_ACCT = 'acct-5210';
const SITE_ACCT = 'acct-5220';
const CC_ADMIN = 'cc-admin';
const CC_SITE = 'cc-site';
const CC_UNMAPPED = 'cc-unmapped';

const build = (over: Partial<BuildLabourDebitInput>) => buildLabourDebitLines({
  runLines: [],
  employeeCostCentre: {},
  employeeAllocations: {},
  mappings: {},
  defaultAccountId: DEFAULT_ACCT,
  taggableCostCentres: new Set([CC_ADMIN, CC_SITE, CC_UNMAPPED]),
  ...over,
});
const view = (lines: ReturnType<typeof buildLabourDebitLines>) => lines.map((l) => [l.glAccountId, l.cc1Id, l.debit]);
const cents = (lines: ReturnType<typeof buildLabourDebitLines>) => lines.reduce((s, l) => s + Math.round(l.debit * 100), 0);

describe('buildLabourDebitLines tags each labour line with its CC1', () => {
  it('a single mapped centre: the line carries that centre', () => {
    const lines = build({
      runLines: [{ employeeId: 'e1', labourAmount: 1000 }, { employeeId: 'e2', labourAmount: 500 }],
      employeeCostCentre: { e1: CC_ADMIN, e2: CC_ADMIN },
      mappings: { [CC_ADMIN]: ADMIN_ACCT },
    });
    expect(view(lines)).toEqual([[ADMIN_ACCT, CC_ADMIN, 1500]]);
  });

  it('an allocation over two centres mapped to the SAME account gives two lines, one per CC1', () => {
    const lines = build({
      runLines: [{ employeeId: 'e1', labourAmount: 1000 }],
      employeeCostCentre: { e1: CC_UNMAPPED }, // allocations override the employee's own centre
      employeeAllocations: { e1: [{ costCentreId: CC_ADMIN, percentage: 60 }, { costCentreId: CC_SITE, percentage: 40 }] },
      mappings: { [CC_ADMIN]: ADMIN_ACCT, [CC_SITE]: ADMIN_ACCT },
    });
    expect(view(lines)).toEqual([[ADMIN_ACCT, CC_ADMIN, 600], [ADMIN_ACCT, CC_SITE, 400]]);
  });

  it('an unmapped centre falls to the default account and KEEPS its CC1', () => {
    const lines = build({
      runLines: [{ employeeId: 'e1', labourAmount: 700 }, { employeeId: 'e2', labourAmount: 300 }],
      employeeCostCentre: { e1: CC_UNMAPPED, e2: CC_ADMIN },
      mappings: { [CC_ADMIN]: ADMIN_ACCT },
    });
    expect(view(lines)).toEqual([[ADMIN_ACCT, CC_ADMIN, 300], [DEFAULT_ACCT, CC_UNMAPPED, 700]]);
  });

  it('no centre: default account, CC1 null — the legacy single line', () => {
    const lines = build({
      runLines: [{ employeeId: 'e1', labourAmount: 700 }, { employeeId: 'e2', labourAmount: 300 }],
      employeeCostCentre: { e1: null },
    });
    expect(view(lines)).toEqual([[DEFAULT_ACCT, null, 1000]]);
  });

  it('a centre the ledger would refuse as CC1 posts untagged on the account its mapping picks', () => {
    const lines = build({
      runLines: [{ employeeId: 'e1', labourAmount: 700 }, { employeeId: 'e2', labourAmount: 300 }, { employeeId: 'e3', labourAmount: 50 }],
      employeeCostCentre: { e1: CC_SITE, e2: CC_UNMAPPED, e3: null },
      mappings: { [CC_SITE]: SITE_ACCT },
      taggableCostCentres: new Set(),
    });
    expect(view(lines)).toEqual([[SITE_ACCT, null, 700], [DEFAULT_ACCT, null, 350]]);
  });

  it('ties to the cent: the allocation residual goes on the last share, per employee', () => {
    const lines = build({
      runLines: [{ employeeId: 'e1', labourAmount: 100 }, { employeeId: 'e2', labourAmount: 100.01 }],
      employeeAllocations: {
        e1: [{ costCentreId: CC_ADMIN, percentage: 33.33 }, { costCentreId: CC_SITE, percentage: 33.33 }, { costCentreId: CC_UNMAPPED, percentage: 33.34 }],
        e2: [{ costCentreId: CC_ADMIN, percentage: 50 }, { costCentreId: CC_SITE, percentage: 50 }],
      },
      mappings: { [CC_ADMIN]: ADMIN_ACCT, [CC_SITE]: ADMIN_ACCT },
    });
    // e2: 50.005 → 50.01 + 50.01 = 100.02, so its last share (CC_SITE) takes −0.01.
    expect(view(lines)).toEqual([[ADMIN_ACCT, CC_ADMIN, 83.34], [ADMIN_ACCT, CC_SITE, 83.33], [DEFAULT_ACCT, CC_UNMAPPED, 33.34]]);
    expect(cents(lines)).toBe(20001);
  });

  it('orders by account then CC1, untagged after tagged, the default account last — whatever the input order', () => {
    const runLines = [
      { employeeId: 'e1', labourAmount: 10 }, { employeeId: 'e2', labourAmount: 20 }, { employeeId: 'e3', labourAmount: 30 },
      { employeeId: 'e4', labourAmount: 40 }, { employeeId: 'e5', labourAmount: 50 }, { employeeId: 'e6', labourAmount: 60 },
    ];
    const employeeCostCentre = { e1: CC_SITE, e2: CC_ADMIN, e3: null, e4: CC_UNMAPPED, e5: 'cc-inactive', e6: CC_SITE };
    const mappings = { [CC_ADMIN]: SITE_ACCT, [CC_SITE]: ADMIN_ACCT, 'cc-inactive': ADMIN_ACCT };
    const expected = [
      [ADMIN_ACCT, CC_SITE, 70], [ADMIN_ACCT, null, 50],
      [SITE_ACCT, CC_ADMIN, 20],
      [DEFAULT_ACCT, CC_UNMAPPED, 40], [DEFAULT_ACCT, null, 30],
    ];
    expect(view(build({ runLines, employeeCostCentre, mappings }))).toEqual(expected);
    expect(view(build({ runLines: [...runLines].reverse(), employeeCostCentre, mappings }))).toEqual(expected);
  });
});
