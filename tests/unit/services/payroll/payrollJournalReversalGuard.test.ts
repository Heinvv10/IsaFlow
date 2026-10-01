/**
 * The payroll guard on the generic journal reversal — its decision, without a database
 * (W3-01 round 6). The integration suites (brkr-c1/c3/c7, w3-01-reversed-journal-reapprove,
 * w3-01-reversal-guard-locks) prove it against Postgres; they skip where CI has no DB, and
 * reverseJournalEntry is shared by every ledger flow, so the rules are pinned here too:
 *   · only `auto_payroll` journals are judged;
 *   · the run is the one LINKING the chain's first journal, else the one whose period the
 *     description names ("Payroll run YYYY-MM");
 *   · a chain netting to zero cannot be reversed again (it would re-book the run);
 *   · the in-force journal of an approved or paid run — the linking run only — is refused;
 *   · links that loop or never end are refused;
 *   · the live path's lock wait running out is PayrollRunBusyError.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ run: null as null | Record<string, unknown>, calls: [] as unknown[][] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (_s: TemplateStringsArray, ...values: unknown[]) => { db.calls.push(values); return db.run ? [db.run] : []; }),
}));
vi.mock('@/modules/accounting/services/payroll/payrollJournalChain', () => ({
  MAX_CHAIN_JOURNALS: 25,
  findChainRoot: vi.fn(),
  readJournalChain: vi.fn(),
  lockJournalChain: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({
  lockPayrollRunHeader: vi.fn(async () => ({})),
  withBoundedLockWait: vi.fn(async (_run: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

import { findChainRoot, readJournalChain } from '@/modules/accounting/services/payroll/payrollJournalChain';
import { lockPayrollRunHeader } from '@/modules/accounting/services/payroll/payrollRunLock';
import { PayrollLoanLockTimeoutError } from '@/modules/accounting/services/payroll/payrollRunLoanApplication';
import {
  PayrollJournalReversalRefusedError,
  PayrollRunBusyError,
  payrollReversalRefusal,
  refuseReversalAgainstPayRun,
} from '@/modules/accounting/services/payroll/payrollJournalReversalGuard';

const journal = (id: string, description = 'Payroll run 2026-04') => ({ id, entryNumber: `JE-${id}`, entryDate: '2026-04-30', status: 'posted', description });
function chain(state: 'in_force' | 'out' | 'unclear', opts: { broken?: boolean; description?: string } = {}) {
  vi.mocked(readJournalChain).mockResolvedValue({
    journals: [journal('J1', opts.description), journal('C1', 'Reversal of JE-J1')], state, broken: opts.broken ?? false,
  });
}
const linkedRun = (status: string) => { db.run = { id: 'run-1', status, links_root: true }; };
const PAYROLL = { id: 'J1', source: 'auto_payroll' };

beforeEach(() => {
  vi.clearAllMocks();
  db.run = null; db.calls = [];
  vi.mocked(findChainRoot).mockResolvedValue('J1');
});

describe('payrollReversalRefusal (the decision, read-only)', () => {
  it('judges nothing that is not an auto_payroll journal', async () => {
    expect(await payrollReversalRefusal('c1', { id: 'J1', source: 'manual' })).toBeNull();
    expect(await payrollReversalRefusal('c1', { id: 'J1' })).toBeNull();
    expect(findChainRoot).not.toHaveBeenCalled();
  });

  it.each([['approved'], ['paid']])('refuses the in-force journal of a linked %s run', async (status) => {
    chain('in_force'); linkedRun(status);
    expect(await payrollReversalRefusal('c1', PAYROLL)).toMatch(status === 'paid' ? /PAID pay run/ : /Reopen the pay run first/);
  });

  it.each([['calculated'], ['draft']])('allows the in-force journal of a linked %s run', async (status) => {
    chain('in_force'); linkedRun(status);
    expect(await payrollReversalRefusal('c1', PAYROLL)).toBeNull();
  });

  it('a run found only by the description\'s period: its status does not matter, re-booking still does', async () => {
    chain('in_force'); db.run = { id: 'run-1', status: 'approved', links_root: false };
    expect(await payrollReversalRefusal('c1', PAYROLL)).toBeNull();
    chain('out');
    expect(await payrollReversalRefusal('c1', PAYROLL)).toMatch(/would put the run's amounts back/);
  });

  it('looks the run up by the period the description names, and by nothing for any other description', async () => {
    chain('in_force', { description: 'Payroll run 2026-04' }); linkedRun('calculated');
    await payrollReversalRefusal('c1', PAYROLL);
    expect(db.calls.at(-1)).toEqual(expect.arrayContaining([2026, 4]));
    chain('in_force', { description: 'UIF declaration 2026-04' });
    await payrollReversalRefusal('c1', PAYROLL);
    expect(db.calls.at(-1)).toEqual(expect.arrayContaining([-1]));
    expect(db.calls.at(-1)).not.toContain(2026);
  });

  it('allows an auto_payroll journal no run claims (a UIF or tax-directive payment)', async () => {
    chain('out', { description: 'UIF declaration 2026-04' });
    expect(await payrollReversalRefusal('c1', PAYROLL)).toBeNull();
  });

  it('refuses re-booking a chain that nets to zero, whatever the run\'s status', async () => {
    for (const status of ['calculated', 'approved']) {
      chain('out'); linkedRun(status);
      expect(await payrollReversalRefusal('c1', PAYROLL)).toMatch(/approve the pay run/);
    }
  });

  it('refuses links that loop or never end — whether or not the root is reached', async () => {
    chain('unclear', { broken: true }); linkedRun('calculated');
    expect(await payrollReversalRefusal('c1', PAYROLL)).toMatch(/do not form a chain that ends/);
    vi.mocked(findChainRoot).mockResolvedValue(null);
    expect(await payrollReversalRefusal('c1', PAYROLL)).toMatch(/do not form a chain that ends/);
  });
});

describe('refuseReversalAgainstPayRun (the live path)', () => {
  it('throws the refusal it judged', async () => {
    chain('in_force'); linkedRun('approved');
    await expect(refuseReversalAgainstPayRun('c1', PAYROLL)).rejects.toBeInstanceOf(PayrollJournalReversalRefusedError);
  });

  it('a lock wait that runs out is PayrollRunBusyError, with a neutral retry message', async () => {
    chain('in_force'); linkedRun('calculated');
    vi.mocked(lockPayrollRunHeader).mockRejectedValueOnce(new PayrollLoanLockTimeoutError('run-1'));
    const err = await refuseReversalAgainstPayRun('c1', PAYROLL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayrollRunBusyError);
    expect(err).toMatchObject({ code: 'PAYROLL_RUN_LOCK_TIMEOUT', message: expect.stringMatching(/being changed by another request — retry/) });
    expect((err as Error).message).not.toMatch(/calculated/);
  });

  it('passes a journal it has no business with, without taking a lock', async () => {
    await refuseReversalAgainstPayRun('c1', { id: 'J1', source: 'manual' });
    chain('in_force', { description: 'UIF declaration 2026-04' });
    await refuseReversalAgainstPayRun('c1', PAYROLL);
    expect(lockPayrollRunHeader).not.toHaveBeenCalled();
  });
});
