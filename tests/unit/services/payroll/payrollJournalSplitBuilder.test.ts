import { describe, it, expect } from 'vitest';
import { buildLabourDebitLines } from '@/modules/accounting/services/payroll/payrollJournalSplitBuilder';

const DEFAULT_ACCT = 'default-5200';
const ADMIN_ACCT = 'acct-admin';
const PROJ_ACCT = 'acct-proj';

const CC_ADMIN = 'cc-admin';
const CC_PROJ = 'cc-proj';

const EMP_A = 'emp-a';
const EMP_B = 'emp-b';

describe('buildLabourDebitLines', () => {
  it('collapses to a single default line when no mappings exist', () => {
    const lines = buildLabourDebitLines({
      runLines: [
        { employeeId: EMP_A, labourAmount: 10000 },
        { employeeId: EMP_B, labourAmount: 5000 },
      ],
      employeeCostCentre: { [EMP_A]: CC_ADMIN, [EMP_B]: CC_PROJ },
      employeeAllocations: {},
      mappings: {},
      defaultAccountId: DEFAULT_ACCT,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.glAccountId).toBe(DEFAULT_ACCT);
    expect(lines[0]!.debit).toBe(15000);
  });

  it('routes each employee to their centre\'s mapped account when present', () => {
    const lines = buildLabourDebitLines({
      runLines: [
        { employeeId: EMP_A, labourAmount: 10000 },
        { employeeId: EMP_B, labourAmount: 5000 },
      ],
      employeeCostCentre: { [EMP_A]: CC_ADMIN, [EMP_B]: CC_PROJ },
      employeeAllocations: {},
      mappings: { [CC_ADMIN]: ADMIN_ACCT, [CC_PROJ]: PROJ_ACCT },
      defaultAccountId: DEFAULT_ACCT,
    });
    const byAcct = Object.fromEntries(lines.map(l => [l.glAccountId, l.debit]));
    expect(byAcct[ADMIN_ACCT]).toBe(10000);
    expect(byAcct[PROJ_ACCT]).toBe(5000);
    expect(byAcct[DEFAULT_ACCT]).toBeUndefined();
  });

  it('falls back to default account for unmapped centres', () => {
    const lines = buildLabourDebitLines({
      runLines: [
        { employeeId: EMP_A, labourAmount: 10000 },
        { employeeId: EMP_B, labourAmount: 5000 },
      ],
      employeeCostCentre: { [EMP_A]: CC_ADMIN, [EMP_B]: CC_PROJ },
      employeeAllocations: {},
      mappings: { [CC_ADMIN]: ADMIN_ACCT },
      defaultAccountId: DEFAULT_ACCT,
    });
    const byAcct = Object.fromEntries(lines.map(l => [l.glAccountId, l.debit]));
    expect(byAcct[ADMIN_ACCT]).toBe(10000);
    expect(byAcct[DEFAULT_ACCT]).toBe(5000);
  });

  it('splits an allocated employee across mapped accounts with residual on default', () => {
    const lines = buildLabourDebitLines({
      runLines: [{ employeeId: EMP_A, labourAmount: 100 }],
      employeeCostCentre: { [EMP_A]: null },
      employeeAllocations: {
        [EMP_A]: [
          { costCentreId: CC_ADMIN, percentage: 33.33 },
          { costCentreId: CC_PROJ, percentage: 33.33 },
          { costCentreId: 'cc-z', percentage: 33.34 },
        ],
      },
      mappings: { [CC_ADMIN]: ADMIN_ACCT, [CC_PROJ]: PROJ_ACCT },
      defaultAccountId: DEFAULT_ACCT,
    });
    const total = lines.reduce<number>((s, l) => s + l.debit, 0);
    expect(total).toBeCloseTo(100, 2);
    const byAcct = Object.fromEntries(lines.map(l => [l.glAccountId, l.debit]));
    expect(byAcct[ADMIN_ACCT]).toBeCloseTo(33.33, 2);
    expect(byAcct[PROJ_ACCT]).toBeCloseTo(33.33, 2);
    expect(byAcct[DEFAULT_ACCT]).toBeCloseTo(33.34, 2);
  });

  it('groups multiple employees routed to the same account into one line', () => {
    const lines = buildLabourDebitLines({
      runLines: [
        { employeeId: EMP_A, labourAmount: 10000 },
        { employeeId: EMP_B, labourAmount: 5000 },
      ],
      employeeCostCentre: { [EMP_A]: CC_ADMIN, [EMP_B]: CC_ADMIN },
      employeeAllocations: {},
      mappings: { [CC_ADMIN]: ADMIN_ACCT },
      defaultAccountId: DEFAULT_ACCT,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.glAccountId).toBe(ADMIN_ACCT);
    expect(lines[0]!.debit).toBe(15000);
  });

  it('orders lines with default last so reversal is deterministic', () => {
    const lines = buildLabourDebitLines({
      runLines: [
        { employeeId: EMP_A, labourAmount: 10000 },
        { employeeId: EMP_B, labourAmount: 5000 },
      ],
      employeeCostCentre: { [EMP_A]: CC_ADMIN, [EMP_B]: null },
      employeeAllocations: {},
      mappings: { [CC_ADMIN]: ADMIN_ACCT },
      defaultAccountId: DEFAULT_ACCT,
    });
    expect(lines[lines.length - 1]!.glAccountId).toBe(DEFAULT_ACCT);
  });

  it('handles an empty run', () => {
    const lines = buildLabourDebitLines({
      runLines: [],
      employeeCostCentre: {},
      employeeAllocations: {},
      mappings: {},
      defaultAccountId: DEFAULT_ACCT,
    });
    expect(lines).toEqual([]);
  });
});
