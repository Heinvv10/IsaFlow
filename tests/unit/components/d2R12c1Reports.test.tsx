// D2 round 12c (1): commentary refresh clears stale rows for changed params and generate's own sentence;
// CurrencyList toggle shows the server's message; usePackDownload drops a stale error; Retry on the two payroll cards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, renderHook, act, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, MSG, ok, on, refuse, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { CommentaryPanel } from '@/components/accounting/commentary/CommentaryPanel';
import { CurrencyList } from '@/components/accounting/currencies/CurrencyList';
import { usePackDownload } from '@/components/accounting/packs/usePackDownload';
import { ApplyPackageCard } from '@/components/payroll/ApplyPackageCard';
import { CostCentreAssignmentCard } from '@/components/payroll/CostCentreAssignmentCard';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(notify.error).mockReset(); });
afterEach(() => { cleanup(); });

const A = { type: 'management' as const, from: '2026-08-01', to: '2026-08-31' };
const B = { type: 'management' as const, from: '2026-09-01', to: '2026-09-30' };
const ROW = {
  id: 'r1', sectionRef: 'income_statement', rowRef: 'revenue', draftText: 'AUGUST SENTENCE', approvedText: null,
  status: 'draft', approvedBy: null, approvedAt: null, withdrawnBy: null, withdrawnAt: null,
};

describe('commentary', () => {
  it('a failed refresh for CHANGED params clears the old pack rows and shows the error', async () => {
    serve(on('GET', 'from=2026-08-01', () => ok({ commentary: [ROW] })), on('GET', 'from=2026-09-01', empty500));
    const view = render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={A} />);
    await screen.findByText('AUGUST SENTENCE');
    view.rerender(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={B} />);
    expect(await screen.findByText('Could not load the commentary - try again')).toBeDefined();
    expect(screen.queryByText('AUGUST SENTENCE')).toBeNull();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });
  it('a failed refresh for the SAME params keeps the rows (approve then reload failure)', async () => {
    let reload = 0;
    serve(
      (u, m) => (m === 'GET' && u.includes('/commentary?') ? (reload++ === 0 ? ok({ commentary: [ROW] }) : empty500()) : undefined),
      on('POST', '/approve', () => ok({})),
    );
    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={A} />);
    await screen.findByText('AUGUST SENTENCE');
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(await screen.findByText('Could not load the commentary - try again')).toBeDefined();
    expect(screen.getByText('AUGUST SENTENCE')).toBeDefined();
  });
  it('a refused generate says "generate", not "save"', async () => {
    serve(on('GET', '/commentary?', () => ok({ commentary: [] })), on('POST', '/api/accounting/commentary', empty500));
    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={A} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('Could not generate the commentary - try again')).toBeDefined();
  });
});

describe('CurrencyList toggle', () => {
  const cur = [{ code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: true }];
  const toggle = async (answer: () => Response) => {
    serve(on('PUT', '/currencies', answer));
    render(<CurrencyList currencies={cur} reportingCurrency="ZAR" onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Deactivate/ }));
  };
  it('403 with a message: the server words are shown', async () => {
    await toggle(() => refuse(MSG, 403));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(MSG));
  });
  it('empty 500: the plain sentence', async () => {
    await toggle(empty500);
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not update the currency - try again'));
  });
});

describe('usePackDownload', () => {
  it('a refusal for one pack is cleared when the period changes', async () => {
    serve(on('GET', '/packs/', () => refuse()));
    const { result, rerender } = renderHook((p: { to: string }) => usePackDownload({ packType: 'board', from: '2026-01-01', to: p.to }), { initialProps: { to: '2026-08-31' } });
    await act(async () => { await result.current.download('pdf'); });
    expect(result.current.error).toBe(MSG);
    rerender({ to: '2026-09-30' });
    await waitFor(() => expect(result.current.error).toBeNull());
  });
});

describe('Retry on a failed load', () => {
  it('ApplyPackageCard: refused, then Retry loads the packages', async () => {
    let n = 0;
    serve((u, m) => (m === 'GET' && u.includes('pay-packages') ? (n++ === 0 ? refuse() : ok([{ id: 'p1', code: 'PK1', name: 'D2 Package', isActive: true }])) : undefined));
    render(<ApplyPackageCard employeeId="e1" />);
    expect(await screen.findByText(MSG)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/D2 Package/)).toBeDefined();
    expect(screen.queryByText(MSG)).toBeNull();
  });
  it('CostCentreAssignmentCard: refused, then Retry loads the centres', async () => {
    let n = 0;
    serve(
      (u, m) => (m === 'GET' && u.includes('/cost-centres') ? (n++ === 0 ? refuse() : ok([{ id: 'cc1', code: 'D2', name: 'D2 Centre', isActive: true }])) : undefined),
      on('GET', 'cost-allocations', () => ok([])),
    );
    render(<CostCentreAssignmentCard employeeId="e1" currentCostCentreId={null} onChange={vi.fn()} />);
    expect(await screen.findByText(MSG)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/D2 Centre/)).toBeDefined();
    expect(screen.queryByText(MSG)).toBeNull();
  });
});
