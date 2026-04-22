/**
 * Unit tests for expectationCronService.runDailyExpectationCron
 *
 * Orchestrates per-company: recompute → detectGaps → autoChase (opt-in).
 * Mocks the three service functions + sql directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn().mockReturnValue('') }),
}));

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/modules/accounting/services/capture/expectationEngineService', () => ({
  recomputeAllForCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/capture/missingInvoiceChaseService', () => ({
  detectGaps: vi.fn(),
  sendEmailChase: vi.fn(),
}));

import { recomputeAllForCompany } from '@/modules/accounting/services/capture/expectationEngineService';
import { detectGaps, sendEmailChase } from '@/modules/accounting/services/capture/missingInvoiceChaseService';
import { runDailyExpectationCron } from '@/modules/accounting/services/capture/expectationCronService';

const COMPANY_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const COMPANY_B = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('runDailyExpectationCron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recomputeAllForCompany).mockResolvedValue({ processed: 0, locked: 0 });
    vi.mocked(detectGaps).mockResolvedValue({ created: 0, unchanged: 0 });
    vi.mocked(sendEmailChase).mockResolvedValue({ sent: true });
  });

  it('processes every active company in the companies table', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: COMPANY_A, chase_auto_send_enabled: false, chase_grace_days: 3 },
      { id: COMPANY_B, chase_auto_send_enabled: false, chase_grace_days: 3 },
    ] as never);

    const result = await runDailyExpectationCron();

    expect(result.companiesProcessed).toBe(2);
    expect(vi.mocked(recomputeAllForCompany)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(detectGaps)).toHaveBeenCalledTimes(2);
  });

  it('skips autoChase when chase_auto_send_enabled is false', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: COMPANY_A, chase_auto_send_enabled: false, chase_grace_days: 3 },
    ] as never);

    await runDailyExpectationCron();

    expect(vi.mocked(sendEmailChase)).not.toHaveBeenCalled();
  });

  it('runs autoChase and fires sendEmailChase for every overdue alert when opt-in', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([
        { id: COMPANY_A, chase_auto_send_enabled: true, chase_grace_days: 3 },
      ] as never)
      .mockResolvedValueOnce([
        { alert_id: 'alert-1' },
        { alert_id: 'alert-2' },
      ] as never);

    const result = await runDailyExpectationCron();

    expect(vi.mocked(sendEmailChase)).toHaveBeenCalledTimes(2);
    expect(result.totalChasesSent).toBe(2);
    expect(result.perCompany[0]!.chasesSent).toBe(2);
    expect(result.perCompany[0]!.chasesSkipped).toBe(0);
  });

  it('counts skipped chases when sendEmailChase returns sent=false', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([
        { id: COMPANY_A, chase_auto_send_enabled: true, chase_grace_days: 3 },
      ] as never)
      .mockResolvedValueOnce([
        { alert_id: 'alert-no-email' },
      ] as never);

    vi.mocked(sendEmailChase).mockResolvedValueOnce({ sent: false, reason: 'no supplier email' });

    const result = await runDailyExpectationCron();

    expect(result.perCompany[0]!.chasesSent).toBe(0);
    expect(result.perCompany[0]!.chasesSkipped).toBe(1);
    expect(result.totalChasesSent).toBe(0);
  });

  it('catches per-alert throws from sendEmailChase and keeps processing', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([
        { id: COMPANY_A, chase_auto_send_enabled: true, chase_grace_days: 3 },
      ] as never)
      .mockResolvedValueOnce([
        { alert_id: 'alert-throws' },
        { alert_id: 'alert-succeeds' },
      ] as never);

    vi.mocked(sendEmailChase)
      .mockRejectedValueOnce(new Error('SMTP down'))
      .mockResolvedValueOnce({ sent: true });

    const result = await runDailyExpectationCron();

    expect(result.perCompany[0]!.chasesSent).toBe(1);
    expect(result.perCompany[0]!.chasesSkipped).toBe(1);
  });

  it('catches per-company failures without aborting the whole run', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: COMPANY_A, chase_auto_send_enabled: false, chase_grace_days: 3 },
      { id: COMPANY_B, chase_auto_send_enabled: false, chase_grace_days: 3 },
    ] as never);

    vi.mocked(recomputeAllForCompany)
      .mockRejectedValueOnce(new Error('tenant A broken'))
      .mockResolvedValueOnce({ processed: 5, locked: 3 });

    const result = await runDailyExpectationCron();

    expect(result.companiesProcessed).toBe(2);
    expect(result.perCompany[0]!.error).toBe('tenant A broken');
    expect(result.perCompany[1]!.error).toBeUndefined();
    expect(result.perCompany[1]!.recomputed).toBe(5);
  });

  it('respects company.chase_grace_days when filtering overdue alerts', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([
        { id: COMPANY_A, chase_auto_send_enabled: true, chase_grace_days: 7 },
      ] as never)
      .mockResolvedValueOnce([] as never);

    await runDailyExpectationCron();

    // We assert by inspecting the second sql call (the overdue-alert SELECT)
    // for the 7-day grace parameter.
    const overdueCall = vi.mocked(sqlMock).mock.calls[1]!;
    // The template args are [strings, ...values]; find the number 7 in values.
    const flat = JSON.stringify(overdueCall);
    expect(flat).toContain('7');
  });

  it('aggregates totals across multiple companies', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([
        { id: COMPANY_A, chase_auto_send_enabled: false, chase_grace_days: 3 },
        { id: COMPANY_B, chase_auto_send_enabled: false, chase_grace_days: 3 },
      ] as never);

    vi.mocked(detectGaps)
      .mockResolvedValueOnce({ created: 2, unchanged: 0 })
      .mockResolvedValueOnce({ created: 3, unchanged: 1 });

    const result = await runDailyExpectationCron();

    expect(result.totalGapsCreated).toBe(5);
    expect(result.perCompany[0]!.gapsCreated).toBe(2);
    expect(result.perCompany[1]!.gapsCreated).toBe(3);
  });
});
