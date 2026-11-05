/**
 * PR S round seven: a reload in place (loadKey) makes every reply still out stale: a PUT that answers after it does
 * not mark the reloaded invoice saved, or take its body as the server's.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/invoiceAutosaveHarness';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { useServerInvoiceAutosave, type ServerAutosaveOptions } from '@/components/accounting/customer-invoices/useServerInvoiceAutosave';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.mocked(apiFetch).mockReset(); });

const body = (description: string) => ({ id: 'inv-1', clientId: 'c', invoiceDate: '2026-09-01', taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: null, items: [{ description, quantity: 1, unitPrice: 100, taxRate: 15, discount: 0, glAccountId: null, projectId: null, cc2Id: null, buId: null, cc1Id: null }] });
const opts = (description: string | null, loadKey: number): ServerAutosaveOptions => ({ mode: 'server', invoiceId: 'inv-1', loadKey, body: description === null ? null : body(description), problem: null, paused: false });

describe('a reply out across a reload in place', () => {
  it('is stale: it does not mark the reloaded invoice saved', async () => {
    let answer: (r: Response) => void = () => undefined;
    vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>((r) => { answer = r; }));
    const { result, rerender } = renderHook((o: ServerAutosaveOptions) => useServerInvoiceAutosave(o), { initialProps: opts('Loaded', 0) });
    rerender(opts('Edited', 0));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    rerender(opts(null, 1)); // reloading
    rerender(opts('As stored now', 1));
    await act(async () => { answer(ok({ updated: true })); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.savedCount).toBe(0);
    expect(result.current.state).toBeNull();
  });
});
