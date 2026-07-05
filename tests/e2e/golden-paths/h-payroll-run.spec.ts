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
  try {
    const employees = await api.get<any[]>('/api/payroll/employees?limit=1');
    expect(employees.length, 'Demo company must have employees').toBeGreaterThan(0);

    // Reuse the sandbox run a previous suite execution left behind (cleanup
    // below reopens it to 'calculated'), else claim the next free period.
    // Runs are unique per company+month; without reuse every execution would
    // permanently consume a period slot.
    const existing = await api.get<any[]>('/api/payroll/runs');
    const reusable = existing.find(
      (r) => r.periodYear >= 2031 && ['draft', 'calculated'].includes(r.status),
    );
    let runId: string;
    if (reusable) {
      runId = reusable.id;
    } else {
      const used = new Set(existing.map((r) => `${r.periodYear}-${r.periodMonth}`));
      let year = 2031; // future sandbox years — clear of seeded demo data
      let month = 1;
      while (used.has(`${year}-${month}`)) {
        month += 1;
        if (month > 12) {
          month = 1;
          year += 1;
        }
      }
      const run = await api.post<any>('/api/payroll/runs', { month, year });
      expect(run.id).toBeTruthy();
      runId = run.id;
    }

    const calculated = await api.post<any>(`/api/payroll/runs/${runId}/calculate`);
    expect(Number(calculated.employeeCount ?? calculated.totalGross ?? 1)).toBeGreaterThan(0);

    const approved = await api.post<any>(`/api/payroll/runs/${runId}/approve`);
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

    // Cleanup: reopen the run (approved → calculated, needs a ≥5-char reason)
    // so the NEXT execution reuses this same slot. Do NOT reverse the journal:
    // reopen keeps payroll_run_headers.journal_entry_id, and approve's
    // idempotent skip returns that same journal on reuse — reversing it here
    // would make the next run's `status === 'posted'` assertion fail.
    // Residue is bounded: one sandbox run + one posted journal, reused forever.
    try {
      await api.post(`/api/payroll/runs/${runId}/reopen`, {
        reason: 'golden-path sandbox reset',
      });
    } catch (cleanupErr) {
      test.info().annotations.push({
        type: 'cleanup-failed',
        description: String(cleanupErr),
      });
    }
  } finally {
    await api.dispose();
  }
});
