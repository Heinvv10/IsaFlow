// D2 round 6 (g3): supplier invoice detail clears a stale error; write-offs clears rows on a failed reload and
// still says a save succeeded when only the refresh failed; useBankRules clears the rules on a failed load and
// speaks in sentences.
import { act, cleanup, configure, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('@/components/accounting/ap/ThreeWayMatchPanel', () => ({ ThreeWayMatchPanel: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import SupplierInvoiceDetailPage from '../../../pages/accounting/supplier-invoices/[invoiceId]';
import WriteOffsPage from '../../../pages/accounting/write-offs/index';
import { useBankRules } from '@/components/accounting/bank-rules/useBankRules';

useApiJsonOverMock();
const MSG = 'D2 server says no: this request was refused';
const bad400 = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const noRaw = (t: string) => expect(t).not.toMatch(/JSON|Unexpected end|HTTP \d|failed\b|Failed/);
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(notify.error).mockClear(); });
afterEach(() => { cleanup(); });

describe('supplier invoice detail: error is cleared', () => {
  const inv = { id: 'inv-1', invoiceNumber: 'INV-D2', supplierName: 'Acme', status: 'draft', invoiceDate: '2026-03-01', dueDate: '2026-03-31', paymentTerms: '30 days', subtotal: 1, taxAmount: 0, taxRate: 15, totalAmount: 1, balance: 1, notes: '', items: [] };
  it('a refused save, then a good save, no longer shows the old refusal', async () => {
    let put = 0;
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => {
      if ((init?.method ?? 'GET') === 'PUT') { put += 1; return put === 1 ? bad400() : ok({}); }
      return ok(inv);
    });
    render(<SupplierInvoiceDetailPage />);
    fireEvent.click(await screen.findByText('Edit'));
    fireEvent.click(await screen.findByText('Save'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    fireEvent.click(await screen.findByText('Save'));
    await waitFor(() => expect(screen.queryByText(MSG)).toBeNull());
    expect(await screen.findByText('Edit')).toBeTruthy();
  });
});

describe('write-offs', () => {
  const wo = { id: 'w1', writeOffNumber: 'WO-D2-1', clientId: 'c', clientName: 'Cl', invoiceId: 'i', amount: 5, reason: 'r', writeOffDate: '2026-01-01T00:00:00Z', status: 'draft' };
  it('4xx on load shows the server message; empty 500 a plain sentence', async () => {
    const only = (r: () => Response) => async (u: unknown) => (String(u).endsWith('/write-offs') ? r() : ok([]));
    vi.mocked(apiFetch).mockImplementation(only(bad400));
    render(<WriteOffsPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    cleanup();
    vi.mocked(apiFetch).mockImplementation(only(empty500));
    render(<WriteOffsPage />);
    expect(await screen.findByText(/could not load write-offs - try again/i)).toBeTruthy();
    noRaw(document.body.textContent ?? '');
  });
  it('approve succeeds, reload fails: rows cleared AND the page says it was approved', async () => {
    let approved = false;
    vi.mocked(apiFetch).mockImplementation(async (u, init) => {
      if (String(u).includes('write-offs-action')) { approved = true; return ok({}); }
      if (String(u).includes('/write-offs')) return approved ? empty500() : ok({ items: [wo] });
      return ok([]);
    });
    render(<WriteOffsPage />);
    await waitFor(() => expect(document.body.textContent).toContain('WO-D2-1'));
    fireEvent.click(document.querySelector('button[title="Approve"]') as HTMLElement);
    expect(await screen.findByText(/write-off was approved, but the list could not be refreshed/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain('WO-D2-1');
    expect(document.body.textContent).not.toMatch(/could not approve/i);
  });
});

describe('useBankRules', () => {
  const rule = { id: 'r1', ruleName: 'D2 rule', matchField: 'description', matchType: 'contains', matchPattern: 'x', priority: 1, isActive: true };
  const fetchPreview = async () => 0;
  const mount = async () => {
    let fail = false;
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => {
      if ((init?.method ?? 'GET') === 'POST') return empty500();
      return fail ? empty500() : ok({ items: [rule] });
    });
    const hook = renderHook(() => useBankRules({ defaultBankId: 'b', fetchPreview }));
    await waitFor(() => expect(hook.result.current.rules).toHaveLength(1));
    return { hook, failNext: () => { fail = true; } };
  };
  it('a failed reload clears the rules and the selection, with a plain sentence', async () => {
    const { hook, failNext } = await mount();
    act(() => hook.result.current.setSelected(new Set(['r1'])));
    failNext();
    await act(async () => { await hook.result.current.load(); });
    expect(hook.result.current.rules).toEqual([]);
    expect(hook.result.current.selected.size).toBe(0);
    expect(hook.result.current.error).toBe('Could not load the rules - try again');
  });
  it.each([
    ['toggle', /could not change the rule - try again/i],
    ['delete', /could not delete the rule - try again/i],
    ['apply', /could not apply the rules - try again/i],
  ])('empty-500 on %s says a plain sentence', async (action, sentence) => {
    const { hook } = await mount();
    await act(async () => { await hook.result.current.doAction(action, 'r1'); });
    expect(hook.result.current.error).toMatch(sentence);
    noRaw(hook.result.current.error.replace(/Could not [^-]*- try again/, ''));
  });
  it('bulk delete 500 says a plain sentence', async () => {
    const { hook } = await mount();
    act(() => hook.result.current.setSelected(new Set(['r1'])));
    await act(async () => { await hook.result.current.performBulkDelete(); });
    expect(hook.result.current.error).toBe('Could not delete the selected rules - try again');
  });
});
