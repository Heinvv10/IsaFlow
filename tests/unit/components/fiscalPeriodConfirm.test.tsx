/**
 * Audit P3.2: a single fiscal period Close or Lock asks first (Lock says it is
 * permanent), the POST carries confirm: true, and Close is not offered on a
 * period that has not started. Covers the Fiscal Periods tab and the Financial
 * Years page row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/accounting/fiscal-periods/CloseReadinessChecklist', () => ({ CloseReadinessChecklist: () => null }));
vi.mock('@/components/accounting/fiscal-periods/CreateYearModal', () => ({ CreateYearModal: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import { FiscalPeriodsTab } from '@/components/accounting/dashboard/FiscalPeriodsTab';
import { PeriodRow } from '@/components/accounting/financialYears/PeriodRow';
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const base = { periodNumber: 1, fiscalYear: 2026, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const OPEN = { ...base, id: 'p-open', periodName: 'January 2026', startDate: '2026-01-01', endDate: '2026-01-31', status: 'open' };
const CLOSED = { ...base, id: 'p-closed', periodNumber: 2, periodName: 'February 2026', startDate: '2026-02-01', endDate: '2026-02-28', status: 'closed' };
const FUTURE = { ...base, id: 'p-future', fiscalYear: 2099, periodName: 'January 2099', startDate: '2099-01-01', endDate: '2099-01-31', status: 'open' };

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'POST');
const bodyOf = (i: number) => JSON.parse(String(posts()[i]![1]!.body)) as Record<string, unknown>;

function serve() {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (_u, init) =>
    ((init?.method ?? 'GET').toUpperCase() === 'POST' ? ok({}) : ok([OPEN, CLOSED, FUTURE])));
}

const rowOf = (name: string) => screen.getByText(name).closest('tr')!;

describe('fiscal periods tab: single Close and Lock', () => {
  it('Close opens a confirmation and posts nothing until it is confirmed, then sends confirm: true', async () => {
    serve();
    render(<FiscalPeriodsTab />);
    await screen.findByText('January 2026');
    fireEvent.click(within(rowOf('January 2026')).getByRole('button', { name: 'Close' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('January 2026');
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close period' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(0)).toEqual({ id: 'p-open', action: 'close', confirm: true });
  });

  it('Lock warns that it is permanent and cannot be reopened, and Cancel posts nothing', async () => {
    serve();
    render(<FiscalPeriodsTab />);
    await screen.findByText('February 2026');
    fireEvent.click(within(rowOf('February 2026')).getByRole('button', { name: 'Lock' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/permanent/i);
    expect(dialog.textContent).toMatch(/cannot be reopened/i);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toHaveLength(0);
  });

  it('confirmed Lock sends confirm: true', async () => {
    serve();
    render(<FiscalPeriodsTab />);
    await screen.findByText('February 2026');
    fireEvent.click(within(rowOf('February 2026')).getByRole('button', { name: 'Lock' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Lock permanently' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(0)).toEqual({ id: 'p-closed', action: 'lock', confirm: true });
  });

  it('a future period offers no usable Close, and says why', async () => {
    serve();
    render(<FiscalPeriodsTab />);
    await screen.findByText('January 2099');
    const close = within(rowOf('January 2099')).getByRole('button', { name: 'Close' }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(close.title).toBe('This period has not started yet');
  });
});

describe('financial years period row', () => {
  const renderRow = (p: typeof OPEN, onAction = vi.fn()) => {
    render(<table><tbody><PeriodRow period={p as unknown as FiscalPeriod} jeCount={0} loadingId={null} onAction={onAction} /></tbody></table>);
    return onAction;
  };

  it('a future period offers no usable Close', () => {
    const onAction = renderRow(FUTURE);
    const close = screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(close.title).toBe('This period has not started yet');
    fireEvent.click(close);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('a started period still offers Close', () => {
    const onAction = renderRow(OPEN);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onAction).toHaveBeenCalledWith('p-open', 'close');
  });
});
