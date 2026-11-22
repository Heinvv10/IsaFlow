/**
 * Review of the line-level invoice form, finding 1: picking a foreign currency kept the rate the form held, and a ZAR
 * form holds 1, so a USD invoice could be created (or a draft saved) at 1.0 without the user giving a rate. Moving to
 * another currency now clears the rate, and Create, Save Changes and autosave refuse until one is given.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { pickOption } from '../helpers/kitPick';
import { fillLine, INV } from '../helpers/invoiceDefaultsHarness';

const h = vi.hoisted(() => ({ query: {} as Record<string, string> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import NewPage from '../../../pages/accounting/customer-invoices/new';
import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); h.query = {}; });

const CURRENCIES = [{ code: 'USD', name: 'US Dollar' }, { code: 'EUR', name: 'Euro' }];
function serve(invoice: object = INV) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes('currencies')) return ok(CURRENCIES);
    const id = /customers\?id=([^&]+)/.exec(u)?.[1];
    if (id) return ok({ id, name: id, default_vat_type: null });
    if (u.includes('/customers')) return ok([{ id: 'c-acme', name: 'Acme' }]);
    if (init?.method === 'POST' || init?.method === 'PUT') return ok({ id: 'n1' });
    if (u.includes('customer-invoices-detail')) return ok(invoice);
    return ok([]);
  });
}
const sent = (method: string) => vi.mocked(apiFetch).mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);
const rate = () => document.querySelector('input[name="exchangeRate"]') as HTMLInputElement;
const alertText = () => screen.queryAllByRole('alert').map((a) => a.textContent).join(' ');

describe('a currency picked: the rate is the user\'s to give', () => {
  it('new page: ZAR to USD shows no rate, and Create refuses until one is typed', async () => {
    serve();
    render(<NewPage />);
    await pickOption('Client', 'Acme');
    fillLine(0, '100');
    await pickOption('Currency', /USD/);
    expect(Number(rate().value)).toBe(0); // never ZAR's 1
    const create = screen.getByRole('button', { name: /^create invoice$/i }) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(alertText()).toContain('Exchange rate must be greater than 0'));
    expect(sent('POST')).toHaveLength(0);
    fireEvent.change(rate(), { target: { value: '18.5' } });
    fireEvent.click(create);
    await waitFor(() => expect(sent('POST')).toHaveLength(1));
    expect(JSON.parse(String((sent('POST')[0]![1] as RequestInit).body))).toMatchObject({ currencyCode: 'USD', exchangeRate: 18.5 });
  });

  it('USD to EUR clears the USD rate; back to ZAR is 1', async () => {
    serve();
    render(<NewPage />);
    await pickOption('Currency', /USD/);
    fireEvent.change(rate(), { target: { value: '18.5' } });
    await pickOption('Currency', /EUR/);
    expect(Number(rate().value)).toBe(0);
    fireEvent.change(rate(), { target: { value: '20' } });
    await pickOption('Currency', /USD/);
    expect(Number(rate().value)).toBe(0);
    await pickOption('Currency', /ZAR/);
    expect(rate()).toBeNull(); // no field for ZAR; the form holds 1 (sent below)
  });

  it('edit page: a ZAR draft moved to USD sends no PUT, autosave or Save Changes, until a rate is given', async () => {
    h.query = { invoiceId: 'inv-1' };
    serve();
    render(<EditPage />);
    await screen.findByDisplayValue('L');
    await pickOption('Currency', /USD/);
    expect(Number(rate().value)).toBe(0);
    await new Promise((r) => setTimeout(r, 1_800)); // past the autosave debounce
    expect(sent('PUT')).toHaveLength(0);
    const save = screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(alertText()).toContain('Exchange rate must be greater than 0'));
    expect(sent('PUT')).toHaveLength(0);
    fireEvent.change(rate(), { target: { value: '18.5' } });
    fireEvent.click(save);
    await waitFor(() => expect(sent('PUT').length).toBeGreaterThan(0));
    expect(JSON.parse(String((sent('PUT')[0]![1] as RequestInit).body))).toMatchObject({ currencyCode: 'USD', exchangeRate: 18.5 });
  }, 15_000);

  it('edit page: a ZAR draft stored at rate 0 (no rate field to fix it) saves, and sends ZAR\'s 1', async () => {
    h.query = { invoiceId: 'inv-1' };
    serve({ ...INV, exchange_rate: 0 });
    render(<EditPage />);
    await screen.findByDisplayValue('L');
    expect(rate()).toBeNull();
    const save = screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(sent('PUT')).toHaveLength(1));
    expect(alertText()).not.toContain('Exchange rate');
    expect(JSON.parse(String((sent('PUT')[0]![1] as RequestInit).body))).toMatchObject({ currencyCode: 'ZAR', exchangeRate: 1 });
  });

  it('edit page: a code stored in lower case ("zar", " usd") reads as the server reads it (trimmed, upper-cased)', async () => {
    h.query = { invoiceId: 'inv-1' };
    serve({ ...INV, currency_code: 'zar', exchange_rate: 0 });
    const { unmount } = render(<EditPage />);
    await screen.findByDisplayValue('L');
    expect(rate()).toBeNull(); // ZAR: no rate field, and nothing holds Save
    const save = screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(sent('PUT')).toHaveLength(1));
    expect(JSON.parse(String((sent('PUT')[0]![1] as RequestInit).body))).toMatchObject({ currencyCode: 'ZAR', exchangeRate: 1 });
    unmount();
    serve({ ...INV, currency_code: ' usd', exchange_rate: 18.5 });
    render(<EditPage />);
    await screen.findByDisplayValue('L');
    expect(Number(rate().value)).toBe(18.5);
    expect(screen.getByRole('region', { name: 'Invoice totals' }).textContent).toMatch(/ZAR equivalent/);
  });
});
