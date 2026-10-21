/**
 * PR #768 rounds 5-6: the SOCE's "Balances taken on" row is shown only for a
 * period a take-on posted in — at least a cent, since summed postings leave
 * float residue (1e-12) that is not a take-on. The column labels come from
 * the service and are tested there (changesInEquityTakeOn.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));

import { AfsOverviewTab } from '@/components/accounting/afs/AfsOverviewTab';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const column = (subtype: string, label: string, takeOn: number) => ({
  subtype, label, opening: 0, profitForYear: 0, dividends: 0, shareIssue: 0, revaluation: 0, otherMovements: 0, takeOn, closing: takeOn,
});
const report = (columns: ReturnType<typeof column>[]) => ({
  periodStart: '2026-01-01', periodEnd: '2026-12-31', columns,
  totalOpening: 0, totalProfitForYear: 0, totalDividends: 0, totalShareIssue: 0, totalRevaluation: 0, totalOtherMovements: 0,
  totalTakeOn: columns.reduce((s, c) => s + c.takeOn, 0), totalClosing: columns.reduce((s, c) => s + c.closing, 0),
});
// The cash-flow sections are answered with an error: only the SOCE is under test.
const serve = (r: ReturnType<typeof report>) => script((u) => (u.includes('changes-in-equity') ? ok({ report: r }) : new Response('', { status: 500 })));

describe('AFS overview: changes in equity', () => {
  it('shows the take-on row when a take-on posted', async () => {
    serve(report([column('retained_earnings', 'Retained Earnings', 23000), column('opening_balance_equity', 'Opening Balance Equity', 2000)]));
    render(<AfsOverviewTab documentId="d1" periodStart="2026-01-01" periodEnd="2026-12-31" />);
    expect(await screen.findByText('Balances taken on')).toBeTruthy();
  });

  it('hides the row for float residue below a cent', async () => {
    serve(report([column('retained_earnings', 'Retained Earnings', 1e-12)]));
    render(<AfsOverviewTab documentId="d1" periodStart="2026-01-01" periodEnd="2026-12-31" />);
    await screen.findByText('Closing balance');
    expect(screen.queryByText('Balances taken on')).toBeNull();
  });
});
