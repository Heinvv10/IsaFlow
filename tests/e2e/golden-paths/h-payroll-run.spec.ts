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

    // Pick a period with no existing run (runs are unique per company+month).
    const existing = await api.get<any[]>('/api/payroll/runs');
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

    const calculated = await api.post<any>(`/api/payroll/runs/${run.id}/calculate`);
    expect(Number(calculated.employeeCount ?? calculated.totalGross ?? 1)).toBeGreaterThan(0);

    const approved = await api.post<any>(`/api/payroll/runs/${run.id}/approve`);
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

    // Best-effort cleanup: reverse the journal and reopen the run so the
    // sandbox period stays reusable. Failure here must not fail the pin.
    try {
      await api.post('/api/accounting/journal-entries-action', {
        id: approved.journalEntryId,
        action: 'reverse',
      });
      await api.post(`/api/payroll/runs/${run.id}/reopen`);
    } catch {
      // cleanup is advisory only
    }
  } finally {
    await api.dispose();
  }
});
