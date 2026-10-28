/**
 * ModuleSetupChecklist (master-plan W1 PR C, W2 H): shows per-module progress, collapses a
 * complete module, and hides the whole card when everything is done or the load failed.
 * useSetupProgress: real apiJson / assertOk over a scripted apiFetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, refuse } from '../helpers/d2R3a5';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { ModuleSetupChecklist } from '../../../src/components/accounting/dashboard/ModuleSetupChecklist';
import { useSetupProgress, isSetupOpen, isSetupUnknown, SETUP_WAIT_MS } from '../../../src/components/accounting/dashboard/useSetupProgress';
import { buildSetupProgress, type SetupFacts } from '../../../src/modules/accounting/services/core/setupProgressService';
import { NO_FACTS as NONE, ALL_FACTS } from '../helpers/setupFacts';

useApiJsonOverMock();
afterEach(cleanup);

const show = (facts: SetupFacts) => render(<ModuleSetupChecklist progress={buildSetupProgress(facts)} />);

describe('ModuleSetupChecklist', () => {
  it('shows overall and per-module progress for a fresh company', () => {
    show(NONE);
    expect(screen.getByText('0 of 8 done')).toBeTruthy();
    expect(screen.getByText('Sales').closest('button')!.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByText('0/3').length).toBe(1);
    expect(screen.getByRole('link', { name: /Add a customer/ }).getAttribute('href')).toBe('/accounting/customers/new');
  });

  it('counts a finished task and collapses a complete module', () => {
    show({ ...NONE, hasCustomers: true, hasCustomerInvoices: true, hasReceipts: true });
    expect(screen.getByText('3 of 8 done')).toBeTruthy();
    const sales = screen.getByText('Sales').closest('button')!;
    expect(sales.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Complete')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Add a customer/ })).toBeNull();
    fireEvent.click(sales);
    expect(screen.getByRole('link', { name: /Add a customer/ })).toBeTruthy();
  });

  it('hides the card when everything is done', () => {
    const { container } = show(ALL_FACTS);
    expect(container.textContent).toBe('');
  });

  it('renders nothing without progress (loading or failed: no skeleton, so the page does not shift)', () => {
    const { container } = render(<ModuleSetupChecklist progress={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('a done task keeps full text colour (an opacity class dropped the light theme below AA)', () => {
    show({ ...NONE, hasEmployees: true });
    const label = screen.getByText('Add an employee');
    expect(label.className).toContain('line-through');
    expect(label.className).not.toMatch(/opacity/);
  });
});

describe('useSetupProgress', () => {
  it('is open while loading, so "All caught up!" cannot flash first', () => {
    vi.mocked(apiFetch).mockReset().mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useSetupProgress('co-1'));
    expect(result.current.loading).toBe(true);
    expect(isSetupOpen(result.current)).toBe(true);
  });

  it('loads the progress: open while tasks remain, closed when all are done', async () => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(ok(buildSetupProgress(NONE)));
    const open = renderHook(() => useSetupProgress('co-1'));
    await waitFor(() => expect(open.result.current.loading).toBe(false));
    expect(isSetupOpen(open.result.current)).toBe(true);

    vi.mocked(apiFetch).mockReset().mockResolvedValue(ok(buildSetupProgress(ALL_FACTS)));
    const done = renderHook(() => useSetupProgress('co-2'));
    await waitFor(() => expect(done.result.current.loading).toBe(false));
    expect(isSetupOpen(done.result.current)).toBe(false);
  });

  it('a stuck request stops holding Home after SETUP_WAIT_MS', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(apiFetch).mockReset().mockReturnValue(new Promise(() => undefined));
      const { result } = renderHook(() => useSetupProgress('co-1'));
      expect(result.current.loading).toBe(true);
      await act(async () => { vi.advanceTimersByTime(SETUP_WAIT_MS); });
      expect(result.current.loading).toBe(false);
      // Not "All caught up!": the checklist is simply not known yet.
      expect(isSetupOpen(result.current)).toBe(true);
      expect(isSetupUnknown(result.current)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed load is unknown, not complete: a company with open setup must not read "All caught up!"', async () => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(refuse());
    const { result } = renderHook(() => useSetupProgress('co-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.progress).toBeNull();
    expect(isSetupOpen(result.current)).toBe(true);
    expect(isSetupUnknown(result.current)).toBe(true);
  });

  it('a checklist that answers after the wait resolves the unknown state', async () => {
    vi.useFakeTimers();
    try {
      let answer!: (r: Response) => void;
      vi.mocked(apiFetch).mockReset().mockReturnValue(new Promise<Response>((r) => { answer = r; }));
      const { result } = renderHook(() => useSetupProgress('co-1'));
      await act(async () => { vi.advanceTimersByTime(SETUP_WAIT_MS); });
      expect(isSetupUnknown(result.current)).toBe(true);
      await act(async () => { answer(ok(buildSetupProgress(ALL_FACTS))); });
      expect(isSetupUnknown(result.current)).toBe(false);
      expect(isSetupOpen(result.current)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks nothing until there is a company id, then asks once', async () => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(ok(buildSetupProgress(ALL_FACTS)));
    const { result, rerender } = renderHook(({ id }: { id: string | undefined }) => useSetupProgress(id), { initialProps: { id: undefined as string | undefined } });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);
    rerender({ id: 'co-1' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
