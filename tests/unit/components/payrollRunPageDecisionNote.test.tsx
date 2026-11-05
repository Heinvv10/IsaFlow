/**
 * The pay-run page hands the run's `approvalDecision` (what GET /api/payroll/runs/[id] returns) to the sole-approver
 * note: shown for a requester's own approval, absent for an ordinary one and for a run with no decision.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import type { RunDetail } from '@/components/payroll/useRunDetail';

const state = vi.hoisted(() => ({ run: null as unknown }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: 'run-1' }, push: () => undefined }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'admin' }) }));
vi.mock('@/components/payroll/useRunDetail', () => ({
  useRunDetail: () => ({
    run: state.run, setRun: vi.fn(), isLoading: false, error: null, calculating: false, reopening: false,
    approveOpen: false, setApproveOpen: vi.fn(), approvedNow: null, load: vi.fn(), calculate: vi.fn(), onApproved: vi.fn(), reopen: vi.fn(),
  }),
}));
vi.mock('@/components/payroll/useRunInputs', () => ({
  useRunInputs: () => ({ inputs: null, loadError: false, saves: {}, resets: {}, drained: async () => undefined, settled: async () => null }),
}));
vi.mock('@/components/payroll/RunHeaderActions', () => ({ RunHeaderActions: () => null }));
vi.mock('@/components/payroll/PayrollApproveDialog', () => ({ PayrollApproveDialog: () => null }));
vi.mock('@/components/payroll/PayrollRunWarnings', () => ({ PayrollRunWarnings: () => null }));
vi.mock('@/components/payroll/PayrollRunLinesTable', () => ({ PayrollRunLinesTable: () => null, PayrollRunTotals: () => null }));
vi.mock('@/components/payroll/PayRunReviewGrid', () => ({ PayRunReviewGrid: () => null }));
vi.mock('@/components/accounting/approvals/DocumentApprovalPanel', () => ({ DocumentApprovalPanel: () => null, isApprovalHeld: () => false }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';

const run = (approvalDecision: RunDetail['approvalDecision']): RunDetail => ({
  id: 'run-1', periodMonth: 9, periodYear: 2026, status: 'approved', totalGross: 0, totalPaye: 0, totalUif: 0, totalSdl: 0, totalEti: 0,
  totalNet: 0, employeeCount: 0, journalEntryId: 'je-1', approval: null, approvalDecision, lines: [],
});

afterEach(cleanup);

describe('the pay-run page and the sole-approver note', () => {
  it('shows it when the approval was the requester\'s own', () => {
    state.run = run({ selfApprovedSoleApprover: true, preparedByDecider: true });
    render(<PayrollRunDetailPage />);
    expect(screen.getByTestId('self-approved-note').textContent).toMatch(/same person also calculated/);
  });

  it.each([[{ selfApprovedSoleApprover: false, preparedByDecider: false }], [null], [undefined]])('shows nothing for %j', (decision) => {
    state.run = run(decision as RunDetail['approvalDecision']);
    render(<PayrollRunDetailPage />);
    expect(screen.queryByTestId('self-approved-note')).toBeNull();
  });
});
