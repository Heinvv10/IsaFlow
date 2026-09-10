/**
 * Closing a period through the assurance surface runs the readiness checks and
 * REFUSES with the itemised blockers.
 *
 * `closePeriod` has never had a readiness check. It refuses a locked period, an
 * already-closed one and one with open priors, and then closes — over
 * unreconciled banks, draft journals, an out-of-balance trial balance and a
 * subledger that does not tie. The Month-End Workbench runs those checks and
 * shows them to a person, who is free to close anyway; nothing carried them to
 * a caller that is not a person.
 *
 * An agent cannot respect a lock it cannot read, and a boolean is not a lock it
 * can read: "not ready" tells it nothing it can act on. So a refusal names every
 * failing check and its reason, and `dry_run` reports the same thing without
 * touching the period.
 *
 * The UI path is deliberately unchanged — `closePeriod` still closes advisorily.
 * Widening it in place would turn a screen that works today into one that
 * refuses, which is a product decision and not this programme's to make.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  getFiscalPeriodById: vi.fn(),
  closePeriod: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/periodCloseReadinessService', () => ({
  getCloseReadiness: vi.fn(),
}));
vi.mock('@/modules/accounting/services/controls/periodControl', () => ({
  assertPeriodControlAuthority: vi.fn(),
}));
const approval = vi.hoisted(() => ({ preview: vi.fn(), supplied: vi.fn() }));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService', () => ({
  controlledOperationApprovalRequiredForPreview: approval.preview,
  assertSuppliedApprovalExecutable: approval.supplied,
  OperationApprovalRequiredError: class extends Error { readonly code = 'OPERATION_APPROVAL_REQUIRED'; },
}));
vi.mock('@/modules/accounting/services/controls/context', () => ({ requireControlTx: () => ({ principal: {} }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { closePeriod, getFiscalPeriodById } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { getCloseReadiness } from '@/modules/accounting/services/gl/periodCloseReadinessService';
import {
  closePeriodWithReadiness,
  PeriodCloseBlockedError,
  PeriodNotCloseableError,
} from '@/modules/accounting/services/gl/fiscalPeriodCloseService';
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';
import type { ChecklistItem } from '@/modules/accounting/services/gl/periodCloseReadinessService';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PERIOD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER = 'user-1';

function period(overrides: Partial<FiscalPeriod> = {}): FiscalPeriod {
  return {
    id: PERIOD, periodName: 'March 2026', periodNumber: 1, fiscalYear: 2027,
    startDate: '2026-03-01', endDate: '2026-03-31', status: 'open',
    createdAt: 'now', updatedAt: 'now', ...overrides,
  };
}

function item(key: string, status: ChecklistItem['status'], reason = 'because'): ChecklistItem {
  return {
    key: key as ChecklistItem['key'], label: key, status, reason, fixHref: `/x/${key}`,
  };
}

function readiness(items: ChecklistItem[]) {
  return {
    periodId: PERIOD,
    periodLabel: 'March 2026',
    items,
    overallStatus: items.some((i) => i.status === 'fail')
      ? ('fail' as const)
      : items.some((i) => i.status === 'warn') ? ('warn' as const) : ('pass' as const),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFiscalPeriodById).mockResolvedValue(period());
  vi.mocked(getCloseReadiness).mockResolvedValue(readiness([item('tb_balanced', 'pass')]));
  vi.mocked(closePeriod).mockResolvedValue(period({ status: 'closed' }));
  approval.preview.mockResolvedValue({ kind: 'answered', required: false });
});

describe('closePeriodWithReadiness', () => {
  it('closes the period when every check passes', async () => {
    const result = await closePeriodWithReadiness(COMPANY, PERIOD, USER, {});
    expect(closePeriod).toHaveBeenCalledWith(COMPANY, PERIOD, USER);
    expect(result.closed).toBe(true);
    expect(result.period.status).toBe('closed');
  });

  it('REFUSES with every failing check itemised, not with a boolean', async () => {
    vi.mocked(getCloseReadiness).mockResolvedValue(readiness([
      item('bank_reconciled', 'fail', '412 transactions are not reconciled'),
      item('unposted_journals', 'fail', '3 draft journals'),
      item('vat_reviewed', 'warn', 'no VAT return covers this period'),
      item('tb_balanced', 'pass'),
    ]));

    const err = await closePeriodWithReadiness(COMPANY, PERIOD, USER, {}).catch((e) => e);

    expect(err).toBeInstanceOf(PeriodCloseBlockedError);
    expect(err.blockers.map((b: ChecklistItem) => b.key))
      .toEqual(['bank_reconciled', 'unposted_journals']);
    expect(err.blockers[0].reason).toBe('412 transactions are not reconciled');
    expect(err.message).toMatch(/412 transactions are not reconciled/);
  });

  it('does NOT close when a check fails', async () => {
    vi.mocked(getCloseReadiness).mockResolvedValue(readiness([item('tb_balanced', 'fail')]));
    await expect(closePeriodWithReadiness(COMPANY, PERIOD, USER, {})).rejects.toThrow();
    expect(closePeriod).not.toHaveBeenCalled();
  });

  it('warns do not block — they are reported alongside the close', async () => {
    vi.mocked(getCloseReadiness).mockResolvedValue(readiness([
      item('vat_reviewed', 'warn', 'no VAT return covers this period'),
    ]));

    const result = await closePeriodWithReadiness(COMPANY, PERIOD, USER, {});

    expect(result.closed).toBe(true);
    expect(result.warnings.map((w) => w.key)).toEqual(['vat_reviewed']);
  });

  it('runs EVERY guard on a dry run and writes nothing', async () => {
    const result = await closePeriodWithReadiness(COMPANY, PERIOD, USER, { dryRun: true });

    expect(getCloseReadiness).toHaveBeenCalledWith(COMPANY, PERIOD);
    expect(closePeriod).not.toHaveBeenCalled();
    expect(result.closed).toBe(false);
    expect(result.dryRun).toBe(true);
  });

  it('a dry run REFUSES wherever the live call would — that is the whole point', async () => {
    vi.mocked(getCloseReadiness).mockResolvedValue(readiness([item('ar_ties', 'fail')]));
    await expect(
      closePeriodWithReadiness(COMPANY, PERIOD, USER, { dryRun: true }),
    ).rejects.toBeInstanceOf(PeriodCloseBlockedError);
  });

  it('refuses a period in another company as NOT FOUND, before any check runs', async () => {
    vi.mocked(getFiscalPeriodById).mockResolvedValue(null);
    await expect(closePeriodWithReadiness(COMPANY, PERIOD, USER, {}))
      .rejects.toBeInstanceOf(PeriodNotCloseableError);
    expect(getCloseReadiness).not.toHaveBeenCalled();
    expect(closePeriod).not.toHaveBeenCalled();
  });

  it('refuses an already-closed period before running the checks', async () => {
    vi.mocked(getFiscalPeriodById).mockResolvedValue(period({ status: 'closed' }));
    await expect(closePeriodWithReadiness(COMPANY, PERIOD, USER, {}))
      .rejects.toThrow(/already closed/i);
    expect(getCloseReadiness).not.toHaveBeenCalled();
  });

  it('refuses a locked period', async () => {
    vi.mocked(getFiscalPeriodById).mockResolvedValue(period({ status: 'locked' }));
    await expect(closePeriodWithReadiness(COMPANY, PERIOD, USER, {})).rejects.toThrow(/locked/i);
  });

  it('reports a check that could not be computed as a blocker, not as a pass', async () => {
    // getCloseReadiness degrades a check that threw to `warn` with a fixed
    // reason. Treating "could not compute" as a warning is right for a screen a
    // person reads and wrong for a caller that is not a person, so the close is
    // blocked and the reason says so.
    vi.mocked(getCloseReadiness).mockResolvedValue(readiness([
      item('ap_ties', 'warn', 'Could not compute — check the relevant module.'),
    ]));

    await expect(closePeriodWithReadiness(COMPANY, PERIOD, USER, {}))
      .rejects.toBeInstanceOf(PeriodCloseBlockedError);
  });

  it('returns the full checklist either way, so a caller sees what it passed', async () => {
    const items = [item('tb_balanced', 'pass'), item('vat_reviewed', 'warn')];
    vi.mocked(getCloseReadiness).mockResolvedValue(readiness(items));
    const result = await closePeriodWithReadiness(COMPANY, PERIOD, USER, {});
    expect(result.checklist.map((i) => i.key)).toEqual(['tb_balanced', 'vat_reviewed']);
  });

  it('refuses when readiness cannot resolve the period at all', async () => {
    vi.mocked(getCloseReadiness).mockResolvedValue(null);
    await expect(closePeriodWithReadiness(COMPANY, PERIOD, USER, {}))
      .rejects.toBeInstanceOf(PeriodNotCloseableError);
    expect(closePeriod).not.toHaveBeenCalled();
  });
});

describe('closePeriodWithReadiness — the approval question on a preview', () => {
  beforeEach(() => {
    vi.mocked(getFiscalPeriodById).mockResolvedValue(period());
    vi.mocked(getCloseReadiness).mockResolvedValue(readiness([item('tb_balanced', 'pass')]));
  });
  it('refuses a preview the live close would refuse for want of an approval', async () => {
    approval.preview.mockResolvedValue({ kind: 'answered', required: true });
    await expect(closePeriodWithReadiness(COMPANY, PERIOD, USER, { dryRun: true }))
      .rejects.toMatchObject({ code: 'OPERATION_APPROVAL_REQUIRED' });
    expect(closePeriod).not.toHaveBeenCalled();
  });
  it('says a preview could not be answered rather than blaming an approval', async () => {
    approval.preview.mockResolvedValue({ kind: 'unavailable', policiesExist: true });
    await expect(closePeriodWithReadiness(COMPANY, PERIOD, USER, { dryRun: true }))
      .rejects.toThrow(/could not be previewed/);
  });
  it('honours a supplied approval the way the live close does', async () => {
    approval.supplied.mockResolvedValue(undefined);
    await expect(closePeriodWithReadiness(COMPANY, PERIOD, USER, { dryRun: true, approvalId: 'approval' }))
      .resolves.toMatchObject({ dryRun: true });
    expect(approval.supplied).toHaveBeenCalledWith(expect.anything(),
      { entityType: 'fiscal_period', entityId: PERIOD, operation: 'fiscal_period.close' }, 'approval');
    expect(approval.preview).not.toHaveBeenCalled();
  });
  it('refuses a preview whose supplied approval the live close would reject', async () => {
    approval.supplied.mockRejectedValue(new Error('Approval is not executable'));
    await expect(closePeriodWithReadiness(COMPANY, PERIOD, USER, { dryRun: true, approvalId: 'approval' }))
      .rejects.toThrow(/not executable/);
  });
  it('previews as before when no approval binds the close', async () => {
    approval.preview.mockResolvedValue({ kind: 'answered', required: false });
    await expect(closePeriodWithReadiness(COMPANY, PERIOD, USER, { dryRun: true })).resolves.toMatchObject({ dryRun: true });
  });
});
