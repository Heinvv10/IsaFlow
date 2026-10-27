/** What GET /api/accounting/budgets answers, for the budgets page tests: FY2026 is Jan-Dec 2026, FY2027 follows it. */
import { expect } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

const keys = (year: number) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

export const YEAR_2026 = { fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-12-31', kind: 'normal', monthKeys: keys(2026) };
export const YEAR_2027 = { fiscalYear: 2027, startDate: '2027-01-01', endDate: '2027-12-31', kind: 'normal', monthKeys: keys(2027) };

/** A budget of `perMonth` in every month of FY2026. */
export const budgetRow = (over: Record<string, unknown> = {}, perMonth = 100) => ({
  id: 'b1', glAccountId: 'g0', accountCode: '4000', accountName: 'D2 Sales Budget', accountType: 'revenue',
  fiscalYear: 2026, annualAmount: perMonth * 12, months: YEAR_2026.monthKeys.map(month => ({ month, amount: perMonth })), ...over,
});

export const budgetsPayload = (items: unknown[], year = YEAR_2026) => ({
  items, fiscalYear: year.fiscalYear, year, monthKeys: year.monthKeys, years: [YEAR_2026, YEAR_2027],
});

/**
 * Click Add Budget once the page's first load has finished. The button renders
 * DISABLED while the year loads, and a click on a disabled button does nothing:
 * clicking as soon as it appears passed on an idle box and, under load, left the
 * form shut until a later wait timed out (a repeat flake, 2026-10-26).
 */
export async function clickAddBudget(): Promise<void> {
  const button = () => screen.getByRole('button', { name: /add budget/i }) as HTMLButtonElement;
  await waitFor(() => expect(button().disabled).toBe(false));
  fireEvent.click(button());
}
