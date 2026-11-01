// A form's date gate has to end with the form. These fields bound the gate by hand, so a refusal outlived the field:
// the form came back showing a good date with no red text, its submit did nothing, and nothing said why. The document
// page fills its form from a reload, and a reload that brought no date left the refused text over an open gate.
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve, writeCalls } from '../helpers/d2R3a6';
import { typeDate } from '../helpers/dateFields';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), isReady: true, pathname: '/' }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co1', vatPeriod: 'monthly', vatSystemType: 'invoice' }, loading: false, companyRole: 'owner' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import ItemAdjustments from '../../../pages/accounting/item-adjustments';
import VatAdjustments from '../../../pages/accounting/vat-adjustments/index';
import RecurringJournals from '../../../pages/accounting/recurring-journals/index';
import DocCapture from '../../../pages/accounting/document-capture/[docId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.query = {}; });
afterEach(cleanup);

const field = (name: RegExp) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const click = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const submit = (input: HTMLInputElement) => fireEvent.submit(input.closest('form')!);
const heldSave = () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { held, release };
};
const unrefused = (input: HTMLInputElement, shown: string) => {
  expect(input.value).toBe(shown);
  expect(input.getAttribute('aria-invalid')).toBe('false');
};

describe.each([
  { name: 'item-adjustments', Page: ItemAdjustments, open: /New Adjustment/, date: /^Date/, path: '/api/accounting/item-adjustments' },
  { name: 'vat-adjustments', Page: VatAdjustments, open: /New Adjustment/, date: /^Adjustment Date/, path: '/api/accounting/vat-adjustments' },
])('$name', ({ Page, open, date, path }) => {
  it('a form cancelled on a refused date comes back able to save', async () => {
    serve(on('POST', path, () => ok({})));
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: open }));
    const shown = field(date).value;
    typeDate(field(date), 'zz');
    await waitFor(() => expect(field(date).getAttribute('aria-invalid')).toBe('true'));
    click(/Cancel/);
    await waitFor(() => expect(screen.queryByRole('textbox', { name: date })).toBeNull());
    expect(screen.queryByText(/Fix the date marked in red/)).toBeNull();
    click(open);
    unrefused(field(date), shown);
    submit(field(date));
    await waitFor(() => expect(writeCalls('POST', path)).toBe(1));
  });

  it('a refusal typed during a save goes with the form it was typed in', async () => {
    const { held, release } = heldSave();
    serve(on('POST', path, () => held.then(() => ok({})) as unknown as Response));
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: open }));
    submit(field(date));
    await waitFor(() => expect(writeCalls('POST', path)).toBe(1));
    typeDate(field(date), 'zz');
    await waitFor(() => expect(field(date).getAttribute('aria-invalid')).toBe('true'));
    release();
    await waitFor(() => expect(screen.queryByRole('textbox', { name: date })).toBeNull());
    click(open);
    expect(field(date).getAttribute('aria-invalid')).toBe('false');
    submit(field(date));
    await waitFor(() => expect(writeCalls('POST', path)).toBe(2));
  });
});

describe('recurring-journals', () => {
  const PATH = '/api/accounting/recurring-journals';
  const DATE = /^First Run Date/;
  const SHOWN = '01 Jun 2027';
  const template = { id: 't1', templateName: 'Rent', frequency: 'monthly', nextRunDate: '2027-06-01', runCount: 0, status: 'active', totalAmount: 1, lines: [] };
  const edit = () => fireEvent.click(screen.getByTitle('Edit'));
  const openEdit = async () => {
    serve(on('PUT', PATH, () => ok({})), on('GET', PATH, () => ok({ items: [template] })));
    render(<RecurringJournals />);
    await screen.findByText('Rent');
    edit();
    typeDate(field(DATE), 'zz');
    await waitFor(() => expect(field(DATE).getAttribute('aria-invalid')).toBe('true'));
  };

  it('a template cancelled on a refused date opens again able to save', async () => {
    await openEdit();
    fireEvent.click(within(field(DATE).closest('form')!).getByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: DATE })).toBeNull());
    edit();
    unrefused(field(DATE), SHOWN);
    submit(field(DATE));
    await waitFor(() => expect(writeCalls('PUT', PATH)).toBe(1));
  });

  it('Edit over refused text puts the template date back, even with the form open on the same date', async () => {
    await openEdit();
    edit();
    await waitFor(() => unrefused(field(DATE), SHOWN));
    submit(field(DATE));
    await waitFor(() => expect(writeCalls('PUT', PATH)).toBe(1));
  });

  it('New Template over refused text gives an empty field, with the form staying open', async () => {
    await openEdit();
    click(/New Template/);
    await waitFor(() => unrefused(field(DATE), ''));
  });
});

describe('document-capture/[docId]', () => {
  const doc = { id: 'doc-1', status: 'pending', readState: 'done', extractedData: null, vendorName: 'V', referenceNumber: null, totalAmount: null, vatAmount: null, documentType: 'invoice', notes: null };
  it('a reload that brings no date clears refused text, so no red date sits over an open gate', async () => {
    let documentDate: string | null = '2026-10-01';
    serve(
      on('POST', 'document-capture-action', () => { documentDate = null; return ok({ success: true }); }),
      on('GET', 'document-capture?id=doc-1', () => ok({ ...doc, documentDate })),
    );
    router.query = { docId: 'doc-1' };
    render(<DocCapture />);
    const date = await screen.findByRole('textbox', { name: /^Date/ }) as HTMLInputElement;
    typeDate(date, 'zz');
    await waitFor(() => expect(date.getAttribute('aria-invalid')).toBe('true'));
    fireEvent.change(screen.getByPlaceholderText('Enter bank transaction ID...'), { target: { value: 'tx1' } });
    click(/^Match$/);
    await waitFor(() => expect(writeCalls('POST', 'document-capture-action')).toBe(1));
    await waitFor(() => unrefused(field(/^Date/), ''));
  });
});
