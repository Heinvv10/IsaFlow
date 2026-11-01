/**
 * Master plan wave 3, PR D blind review: a scan takes seconds, and the form moves on while it reads. The real
 * ScanAndFillButton must hand the answer to the page as it is now, not as it was when the file was picked, or a mode
 * changed meanwhile reads gross prices as ex-VAT.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { ok } from '../helpers/d2CensusG4';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { typeDate } from '../helpers/dateFields';
import { fillLine, invoiceDate, pickClient, pickMode, prices, serve, submitAndWait } from '../helpers/invoiceDefaultsHarness';

const push = vi.hoisted(() => vi.fn());
const job = vi.hoisted(() => ({ finish: undefined as undefined | ((d: unknown) => void) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push, replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/scanAndFillPoll', () => ({
  pollScanJob: () => ({ cancel: vi.fn(), result: new Promise((resolve) => { job.finish = resolve; }) }),
}));

import NewPage from '../../../pages/accounting/customer-invoices/new';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.mocked(apiFetch).mockReset(); job.finish = undefined; });

const summaryTotal = () => screen.getByText('Invoice Summary').closest('.rounded-2xl')!.textContent;
const modeShown = () => screen.getByRole('combobox', { name: 'Amounts are' }).textContent;

async function open() {
  serve();
  const inner = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).includes('vlm-status')) return ok({ available: true });
    if (String(url).includes('vlm-extract')) return ok({ jobId: 'j1' });
    return inner(url, init);
  });
  render(<NewPage />);
  await screen.findByRole('button', { name: /scan invoice/i });
  typeDate(invoiceDate(), '1 Oct 2026');
  await pickClient('c-bare');
}
async function startScan() {
  const file = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(file, { target: { files: [new File(['x'], 'scan.pdf', { type: 'application/pdf' })] } });
  await waitFor(() => expect(job.finish).toBeTruthy());
}
const finishScan = async (data: { vatRate: number | null; lineItems: unknown[] }) => {
  await act(async () => {
    job.finish!({ date: null, dueDate: null, customerName: null, confidence: 0.9, warnings: [], ...data });
    await new Promise((r) => { setTimeout(r); });
  });
  await screen.findByText(/Auto-filled/);
};

describe('the mode changes while a scan reads', () => {
  it('Excluding when the scan starts, Including when it lands: ex-VAT R1000 totals R1150', async () => {
    await open();
    fillLine(0, '1000');
    await startScan();
    await pickMode(/Including VAT/);
    await finishScan({ vatRate: 15, lineItems: [] });
    expect(modeShown()).toMatch(/Including VAT/);
    expect(prices()).toEqual(['1150']);
    expect(summaryTotal()).toMatch(/Total\s*R?\s*1[ , ]?150\.00/);
    await submitAndWait(push);
    const create = vi.mocked(apiFetch).mock.calls.find((c) => String(c[0]).includes('customer-invoices-create'))!;
    expect((JSON.parse(String((create[1] as RequestInit).body)) as { items: { unitPrice: number }[] }).items[0]!.unitPrice).toBe(1000);
  });

  it('Excluding when the scan starts, R100 shown as 115 before it lands: it stays R115', async () => {
    await open();
    await startScan();
    fillLine(0, '100');
    await pickMode(/Including VAT/);
    expect(prices()).toEqual(['115']);
    await finishScan({ vatRate: 15, lineItems: [] });
    expect(modeShown()).toMatch(/Including VAT/);
    expect(prices()).toEqual(['115']);
    expect(summaryTotal()).toMatch(/Total\s*R?\s*115\.00/);
  });

  it('Including when the scan starts, Excluding when it lands, with lines: the scan\'s prices stand', async () => {
    await open();
    await pickMode(/Including VAT/);
    fillLine(0, '115');
    await startScan();
    await pickMode(/Excluding VAT/);
    await finishScan({ vatRate: 15, lineItems: [{ description: 'Scanned', quantity: 1, unitPrice: 200 }] });
    expect(modeShown()).toMatch(/Excluding VAT/);
    expect(prices()).toEqual(['200']);
    expect(summaryTotal()).toMatch(/Total\s*R?\s*230\.00/);
  });

  it('the rate typed while it reads is the one the conversion uses', async () => {
    await open();
    await pickMode(/Including VAT/);
    fillLine(0, '110');
    await startScan();
    fireEvent.change(screen.getByLabelText('VAT rate %'), { target: { value: '10' } });
    await finishScan({ vatRate: null, lineItems: [{ description: 'Scanned', quantity: 1, unitPrice: 200 }] });
    expect(modeShown()).toMatch(/Excluding VAT/);
    expect(prices()).toEqual(['200']);
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).value).toBe('10');
  });
});
