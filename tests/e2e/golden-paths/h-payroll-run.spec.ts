/**
 * Golden path (h): payroll run → calculate → approve → GL journal.
 *
 * Known-good at baseline (payroll VIP-parity phases 1-4 shipped). The spec
 * picks an unused period, runs the full cycle, asserts the GL journal, then
 * best-effort reverses/reopens so repeated runs don't accumulate books noise.
 */
import { test, expect } from '@playwright/test';
import { Api } from './_api';

test('payroll run: create → calculate → approve posts a GL journal', async ({ baseURL }) => {
  const api = await Api.login(baseURL!);
  let approvedRunId = '';
  try {
    const employees = await api.get<any[]>('/api/payroll/employees?limit=1');
    expect(employees.length, 'Demo company must have employees').toBeGreaterThan(0);

    // Reuse the sandbox run a previous suite execution left behind (cleanup
    // below reopens it to 'calculated'), else claim the next free sandbox
    // period. Runs are unique per company+month; without reuse every execution
    // would permanently consume a period slot.
    //
    // The sandbox must sit inside a loaded tax year: calculate refuses a period
    // whose tax tables are not loaded (UnsupportedTaxYearError), so the old
    // 2031+ "future sandbox years" no longer calculate. Jan-Feb 2027 are the
    // only periods that are free in the Demo company (seeded runs stop at Dec
    // 2026), inside tax year 2027, and in an open fiscal period (to Dec 2027).
    // Move this window when Demo needs those months for real runs.
    const SANDBOX_PERIODS = [{ year: 2027, month: 1 }, { year: 2027, month: 2 }];
    const existing = await api.get<any[]>('/api/payroll/runs');
    const inSandbox = (r: any) =>
      SANDBOX_PERIODS.some((p) => p.year === r.periodYear && p.month === r.periodMonth);
    const reusable = existing.find(
      (r) => inSandbox(r) && ['draft', 'calculated'].includes(r.status),
    );
    let runId: string;
    if (reusable) {
      runId = reusable.id;
    } else {
      const used = new Set(existing.map((r) => `${r.periodYear}-${r.periodMonth}`));
      const free = SANDBOX_PERIODS.find((p) => !used.has(`${p.year}-${p.month}`));
      expect(free, 'a sandbox payroll period (Jan/Feb 2027) must be free in Demo').toBeTruthy();
      const run = await api.post<any>('/api/payroll/runs', { month: free!.month, year: free!.year });
      expect(run.id).toBeTruthy();
      runId = run.id;
    }

    const calculated = await api.post<any>(`/api/payroll/runs/${runId}/calculate`);
    expect(Number(calculated.employeeCount ?? calculated.totalGross ?? 1)).toBeGreaterThan(0);

    // Approve as the run page does: preview the journal, then send the hash of
    // what was previewed — the route refuses an approval without it (BRK-596).
    const preview = await api.get<any>(`/api/payroll/runs/${runId}/journal-plan`);
    expect(preview.blocker, 'the costed run must be approvable').toBeNull();
    expect(preview.planHash).toBeTruthy();

    const approved = await api.post<any>(`/api/payroll/runs/${runId}/approve`, {
      expectedPlanHash: preview.planHash,
    });
    approvedRunId = runId;
    expect(approved.status).toBe('approved');
    expect(approved.journalEntryId, 'approve must post a GL journal').toBeTruthy();

    const journal = await api.get<any>(
      `/api/accounting/journal-entries-detail?id=${approved.journalEntryId}`,
    );
    expect(journal.status).toBe('posted');
    expect(journal.source).toBe('auto_payroll');
    const drTotal = journal.lines.reduce((t: number, l: any) => t + Number(l.debit), 0);
    const crTotal = journal.lines.reduce((t: number, l: any) => t + Number(l.credit), 0);
    expect(drTotal).toBeCloseTo(crTotal, 2);
    expect(drTotal).toBeGreaterThan(0);

  } finally {
    // Cleanup IN FINALLY (late #196 review MEDIUM: an assertion failure used
    // to skip cleanup and strand the run 'approved', burning sandbox months).
    // Reopen the run (approved → calculated, needs a ≥5-char reason) so the
    // NEXT execution reuses this same slot. Do NOT reverse the journal:
    // reopen keeps payroll_run_headers.journal_entry_id, and approve's
    // idempotent skip returns that same journal on reuse — reversing it here
    // would make the next run's `status === 'posted'` assertion fail.
    // Residue is bounded: one sandbox run + one posted journal, reused forever.
    try {
      if (approvedRunId) {
        await api.post(`/api/payroll/runs/${approvedRunId}/reopen`, {
          reason: 'golden-path sandbox reset',
        });
      }
    } catch (cleanupErr) {
      test.info().annotations.push({
        type: 'cleanup-failed',
        description: String(cleanupErr),
      });
    }
    await api.dispose();
  }
});
