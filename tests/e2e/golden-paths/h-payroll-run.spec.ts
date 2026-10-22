/**
 * Golden path (h): payroll run → calculate → approve → GL journal.
 *
 * Known-good at baseline (payroll VIP-parity phases 1-4 shipped). The spec
 * picks an unused period, runs the full cycle, asserts the GL journal, then
 * best-effort reverses/reopens so repeated runs don't accumulate books noise.
 */
import { test, expect } from '@playwright/test';
import { Api, PAYROLL_SANDBOX_MONTH } from './_api';

test('payroll run: create → calculate → approve posts a GL journal', async ({ baseURL }) => {
  const api = await Api.login(baseURL!);
  let approvedRunId = '';
  try {
    const employees = await api.get<any[]>('/api/payroll/employees?limit=1');
    expect(employees.length, 'Demo company must have employees').toBeGreaterThan(0);

    // Reuse the sandbox run a previous suite execution left behind (cleanup
    // below reopens it to 'calculated'), else create it. Runs are unique per
    // company+month, so there is exactly one slot and it is reused forever.
    //
    // The sandbox must sit inside a loaded tax year: calculate refuses a period
    // whose tax tables are not loaded (UnsupportedTaxYearError), so the old
    // 2031+ "future sandbox years" no longer calculate. Feb 2027 is the last
    // month of tax year 2027, absent from Demo's seeded runs (they stop at Dec
    // 2026), and in an open fiscal period. It is RESERVED for this spec: the
    // close-agent specs take the first open 2027 period and skip this month
    // (PAYROLL_SANDBOX_MONTH). Jan 2027 is theirs, so it is not a fallback.
    // Move this when Demo needs Feb 2027 for a real payroll run.
    const [sandboxYear, sandboxMonth] = PAYROLL_SANDBOX_MONTH.split('-').map(Number) as [number, number];
    const existing = await api.get<any[]>('/api/payroll/runs');
    const inSandbox = (r: any) => r.periodYear === sandboxYear && r.periodMonth === sandboxMonth;
    const slot = existing.find(inSandbox);
    let runId: string;
    if (slot && ['draft', 'calculated'].includes(slot.status)) {
      runId = slot.id;
    } else {
      expect(
        slot,
        `the sandbox payroll run for ${PAYROLL_SANDBOX_MONTH} is '${slot?.status}', not reusable. `
          + 'A previous run failed its cleanup: reopen it (POST /api/payroll/runs/<id>/reopen) in the Demo '
          + 'company, or use a real run you no longer need. Do not move the spec to another month.',
      ).toBeUndefined();
      const run = await api.post<any>('/api/payroll/runs', { month: sandboxMonth, year: sandboxYear });
      expect(run.id).toBeTruthy();
      runId = run.id;
    }

    // The reused run is reopened, not reversed (cleanup below), so it still
    // links the journal the last execution posted. Calculate refuses a run whose
    // journal is in force while it has loan work (PAYROLL_RUN_JOURNAL_POSTED),
    // so take that journal out first; approval then posts a fresh one.
    const linked = (await api.get<any>(`/api/payroll/runs/${runId}`)).journalEntryId;
    if (linked) {
      const journal = await api.get<any>(`/api/accounting/journal-entries-detail?id=${linked}`);
      if (journal.status === 'posted' && !journal.reversedAt) {
        await api.post('/api/accounting/journal-entries-action', { id: linked, action: 'reverse' });
      }
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
    // NEXT execution reuses this same slot. The next execution reverses the
    // journal before it calculates (above), which also heals a run an earlier
    // failure left calculated with its journal in force. Approval of a run whose
    // journal is out posts a fresh one, so each execution adds one netted pair
    // to the sandbox month and leaves one live journal.
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
