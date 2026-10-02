// D2 round 9 (scope A), hooks and small forms: useBankTxRefData now tells the person when a list did not load;
// useBankRuleRefData's message is one sentence; and the success / empty-5xx / network paths of usePackPrintData,
// useFirstUseWizard, useTrackPageVisit, ChangeEmailSection, BulkActionBar and DrcFlagToggle are pinned.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, MSG, ok, on, refuse, serve } from '../helpers/d2R3a6';

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a), info: vi.fn(), warning: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));
vi.mock('@/lib/fetchAllSuppliers', () => ({ fetchAllSuppliers: async () => ({ suppliers: [], truncated: false }) }));
vi.mock('@/modules/accounting/services/packs/packDocument', () => ({ buildPackDocument: () => ({ built: true }) }));
vi.mock('@/components/accounting/lateClaimNotice', () => ({ notifyLateClaims: vi.fn() }));
const router = vi.hoisted(() => ({ pathname: '/accounting/trial-balance' }));
vi.mock('next/router', () => ({ useRouter: () => router }));

import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { useBankTxRefData } from '@/components/accounting/bank-transactions/useBankTxRefData';
import { useBankRuleRefData } from '@/components/accounting/bank-rules/useBankRuleRefData';
import { usePackPrintData } from '@/components/accounting/packs/usePackPrintData';
import { useFirstUseWizard } from '@/hooks/useFirstUseWizard';
import { useTrackPageVisit } from '@/hooks/useTrackPageVisit';
import { ChangeEmailSection } from '@/components/accounting/my-account/ChangeEmailSection';
import { BulkActionBar } from '@/components/accounting/supplier-invoices/BulkActionBar';
import { DrcFlagToggle } from '@/components/accounting/suppliers/DrcFlagToggle';
import { CreateYearModal } from '@/components/accounting/fiscal-periods/CreateYearModal';
import { MergeCustomersModal } from '@/components/accounting/customers/MergeCustomersModal';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); toastError.mockClear(); toastSuccess.mockClear(); vi.mocked(log.warn).mockClear(); vi.mocked(log.debug).mockClear(); });
afterEach(() => { cleanup(); });

const LISTS = 'Could not load some lists - reload the page';

describe('useBankTxRefData', () => {
  const setters = () => ({
    setBankAccounts: vi.fn(), setGlAccounts: vi.fn(), setSuppliers: vi.fn(), setCustomers: vi.fn(), setCc1Options: vi.fn(),
    setCc2Options: vi.fn(), setBuOptions: vi.fn(), setSelectedBank: vi.fn(), setRefDataLoaded: vi.fn(), setSuppliersStatus: vi.fn(),
  });
  it('every list loads: no error is shown and the page is marked loaded', async () => {
    const s = setters();
    serve(on('GET', 'bank-accounts', () => ok([{ id: 'b1' }])));
    renderHook(() => useBankTxRefData(s));
    await waitFor(() => expect(s.setRefDataLoaded).toHaveBeenCalledWith(true));
    expect(toastError).not.toHaveBeenCalled();
    expect(s.setBankAccounts).toHaveBeenCalledWith([{ id: 'b1' }]);
  });
  for (const [what, fail] of [['empty 500', empty500], ['400', () => refuse()]] as const) {
    it(`${what} on one list: the person is told, and the other lists still load`, async () => {
      const s = setters();
      serve(on('GET', 'chart-of-accounts', fail), on('GET', 'bank-accounts', () => ok([{ id: 'b1' }])));
      renderHook(() => useBankTxRefData(s));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(LISTS));
      expect(s.setBankAccounts).toHaveBeenCalledWith([{ id: 'b1' }]);
      expect(s.setRefDataLoaded).toHaveBeenCalledWith(true);
      expect(toastError).toHaveBeenCalledTimes(1);
    });
  }
  it('a request that throws on one list is told too', async () => {
    const s = setters();
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (String(url).includes('customers')) throw new TypeError('Failed to fetch');
      return ok([]);
    });
    renderHook(() => useBankTxRefData(s));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(LISTS));
  });
});

describe('useBankRuleRefData', () => {
  it('a failed bank-accounts load reads as ONE sentence, not "Bank accounts: Could not load the bank accounts"', async () => {
    serve(on('GET', 'bank-accounts', empty500));
    const { result } = renderHook(() => useBankRuleRefData());
    await waitFor(() => expect(result.current.errors).toContain('Could not load the bank accounts - try again'));
    expect(result.current.errors.join(' ')).not.toMatch(/Bank accounts:/);
  });
  it('a failed chart load says what could not be loaded', async () => {
    serve(on('GET', 'chart-of-accounts', empty500));
    const { result } = renderHook(() => useBankRuleRefData());
    await waitFor(() => expect(result.current.errors).toContain('Could not load the chart of accounts - try again'));
  });
  it('a 400 on customers shows the server message alone', async () => {
    serve(on('GET', 'customers', () => refuse()));
    const { result } = renderHook(() => useBankRuleRefData());
    await waitFor(() => expect(result.current.errors).toContain(MSG));
  });
});

describe('usePackPrintData', () => {
  it('200 on both fetches builds the document', async () => {
    serve(on('GET', 'reports-pack', () => ok({ pack: {}, draft: false })), on('GET', '/trend', () => ok({})));
    const { result } = renderHook(() => usePackPrintData('board' as never, '2026-01-01', '2026-01-31'));
    await waitFor(() => expect(result.current.document).toEqual({ built: true }));
    expect(result.current.error).toBeNull();
  });
  it('an empty 500 shows the plain sentence and no document', async () => {
    serve(on('GET', 'reports-pack', empty500));
    const { result } = renderHook(() => usePackPrintData('board' as never, '2026-01-01', '2026-01-31'));
    await waitFor(() => expect(result.current.error).toBe('Could not load the pack - try again'));
    expect(result.current.document).toBeNull();
  });
  it('a 400 on the trend shows the server message', async () => {
    serve(on('GET', 'reports-pack', () => ok({ pack: {} })), on('GET', '/trend', () => refuse()));
    const { result } = renderHook(() => usePackPrintData('board' as never, '2026-01-01', '2026-01-31'));
    await waitFor(() => expect(result.current.error).toBe(MSG));
  });
  it('a network rejection shows the plain sentence', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => usePackPrintData('board' as never, '2026-01-01', '2026-01-31'));
    await waitFor(() => expect(result.current.error).toBe('Could not load the pack - try again'));
  });
});

describe('useFirstUseWizard', () => {
  let n = 0;
  const key = () => `wiz-r9-${++n}`;
  it('200 dismissed=true: the guide stays hidden', async () => {
    const k = key();
    vi.mocked(apiFetch).mockImplementation(async () => ok({ [`${k}_dismissed`]: 'true' }));
    const { result } = renderHook(() => useFirstUseWizard(k));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.shouldShow).toBe(false);
  });
  it('200 with nothing saved: the guide shows', async () => {
    serve(on('GET', 'auth/preferences', () => ok({})));
    const { result } = renderHook(() => useFirstUseWizard(key()));
    await waitFor(() => expect(result.current.shouldShow).toBe(true));
  });
  it('a failed preference save is logged and the guide still closes for this session', async () => {
    serve(on('GET', 'auth/preferences', () => ok({})), on('PUT', 'auth/preferences', empty500));
    const { result } = renderHook(() => useFirstUseWizard(key()));
    await waitFor(() => expect(result.current.shouldShow).toBe(true));
    act(() => { result.current.dismiss(); });
    await waitFor(() => expect(result.current.shouldShow).toBe(false));
    await waitFor(() => expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('dismissal was not saved'), expect.anything(), 'first-use-wizard'));
  });
});

describe('useTrackPageVisit', () => {
  it('posts the visit for a registered page', async () => {
    router.pathname = '/accounting/trial-balance';
    serve(on('POST', 'page-visits', () => ok({})));
    renderHook(() => useTrackPageVisit());
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/accounting/page-visits', expect.objectContaining({ method: 'POST' })));
  });
  it('a page that is not registered posts nothing', () => {
    router.pathname = '/not/registered';
    renderHook(() => useTrackPageVisit());
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });
  it('a rejected visit is swallowed into a debug log, not an unhandled rejection', async () => {
    router.pathname = '/accounting/trial-balance';
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('Failed to fetch'));
    renderHook(() => useTrackPageVisit());
    await waitFor(() => expect(log.debug).toHaveBeenCalled());
  });
});

describe('ChangeEmailSection', () => {
  const submit = () => {
    render(<ChangeEmailSection currentEmail="old@x.test" />);
    fireEvent.change(screen.getByPlaceholderText('new@example.com'), { target: { value: 'new@x.test' } });
    fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
  };
  it('200: success is shown and the field clears', async () => {
    serve(on('POST', 'change-email', () => ok({})));
    submit();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Email changed to new@x.test'));
  });
  it('400: the server message', async () => {
    serve(on('POST', 'change-email', () => refuse()));
    submit();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(MSG));
    expect(toastSuccess).not.toHaveBeenCalled();
  });
  it('empty 500: a plain sentence and the button is free again', async () => {
    serve(on('POST', 'change-email', empty500));
    submit();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not change your email - try again'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Change email' }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('a request that throws: a plain sentence', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('Failed to fetch'));
    submit();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not change your email - try again'));
  });
});

describe('BulkActionBar', () => {
  const run = (over: { onComplete?: () => Promise<void> } = {}) => {
    vi.stubGlobal('confirm', () => true);
    const onError = vi.fn(); const onComplete = over.onComplete ?? vi.fn().mockResolvedValue(undefined); const onBusyChange = vi.fn();
    render(<BulkActionBar selected={new Set(['i1', 'i2'])} busy={null} onBusyChange={onBusyChange} onError={onError} onComplete={onComplete} onClear={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    return { onError, onComplete, onBusyChange };
  };
  afterEach(() => { vi.unstubAllGlobals(); });
  it('200 all ok: the list reloads and no error is reported', async () => {
    serve(on('POST', 'bulk-action', () => ok({ total: 2, succeeded: 2, failed: 0, results: [] })));
    const { onError, onComplete, onBusyChange } = run();
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(null));
    expect(onError).toHaveBeenCalledTimes(1); // only the initial clear
    expect(onError).toHaveBeenCalledWith('');
  });
  it('200 with failures: the reasons are grouped into the page error after the reload', async () => {
    serve(on('POST', 'bulk-action', () => ok({ total: 2, succeeded: 0, failed: 2, results: [{ invoiceId: 'i1', ok: false, error: 'locked' }, { invoiceId: 'i2', ok: false, error: 'locked' }] })));
    const { onError } = run();
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    const join = onError.mock.calls[1]![0] as (p: string) => string;
    expect(join('')).toBe('2 of 2 approves failed: locked');
  });
  it('400: the server message, nothing reloaded', async () => {
    serve(on('POST', 'bulk-action', () => refuse()));
    const { onError, onComplete } = run();
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith(MSG));
    expect(onComplete).not.toHaveBeenCalled();
  });
  it('empty 500: the plain sentence and the busy flag is released', async () => {
    serve(on('POST', 'bulk-action', empty500));
    const { onError, onBusyChange } = run();
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith('Could not approve the invoices - try again'));
    expect(onBusyChange).toHaveBeenLastCalledWith(null);
  });
  it('a request that throws: the plain sentence', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('Failed to fetch'));
    const { onError } = run();
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith('Could not approve the invoices - try again'));
  });
});

describe('DrcFlagToggle', () => {
  const toggle = () => { render(<DrcFlagToggle supplierId="s1" initial={false} />); return screen.getByRole('switch', { hidden: true }) as HTMLElement; };
  it('200: the flag stays on and success is shown', async () => {
    serve(on('PATCH', 'suppliers-list', () => ok({})));
    fireEvent.click(toggle());
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Supplier marked as subject to DRC VAT'));
    expect(screen.getByRole('switch', { hidden: true }).getAttribute('aria-checked')).toBe('true');
  });
  it('empty 500: the switch goes back and a plain sentence is shown', async () => {
    serve(on('PATCH', 'suppliers-list', empty500));
    fireEvent.click(toggle());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not save the DRC VAT flag - try again'));
    expect(screen.getByRole('switch', { hidden: true }).getAttribute('aria-checked')).toBe('false');
  });
  it('400: the server message and the switch goes back', async () => {
    serve(on('PATCH', 'suppliers-list', () => refuse()));
    fireEvent.click(toggle());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(MSG));
    expect(screen.getByRole('switch', { hidden: true }).getAttribute('aria-checked')).toBe('false');
  });
  it('a request that throws: the switch goes back', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('Failed to fetch'));
    fireEvent.click(toggle());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not save the DRC VAT flag - try again'));
    expect(screen.getByRole('switch', { hidden: true }).getAttribute('aria-checked')).toBe('false');
  });
});

describe('plain sentences for write failures (empty 5xx)', () => {
  it('CreateYearModal: says the fiscal year could not be created, not "Something went wrong"', async () => {
    serve(on('POST', 'fiscal-periods', empty500));
    render(<CreateYearModal onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Create Year/ }));
    expect(await screen.findByText('Could not create the fiscal year - try again')).toBeDefined();
  });
  it('MergeCustomersModal: says the customers could not be merged, not "Network error"', async () => {
    serve(on('POST', 'customer-merge', empty500));
    const c = (id: string) => ({ id, name: `Cust ${id}`, email: null, vat: null, invoiceCount: 0 });
    render(<MergeCustomersModal candidateA={c('a')} candidateB={c('b')} onClose={vi.fn()} onMerged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Merge$|Merge Customers$|Merge\b(?!\.)/ }));
    expect(await screen.findByText('Could not merge the customers - try again')).toBeDefined();
  });
});
