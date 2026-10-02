/**
 * D2 error envelope, group g2d: timesheets, time tracking, VAT adjustments and write-offs show the
 * server's message from a real { success:false, error:{ code, message } } envelope, not "Failed".
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));

import { apiFetch } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import TimesheetsPage from '../../../pages/accounting/timesheets';
import TimeTrackingPage from '../../../pages/accounting/time-tracking';
import VATAdjustmentsPage from '../../../pages/accounting/vat-adjustments';
import WriteOffsPage from '../../../pages/accounting/write-offs';

void mockedApiFetchModule;
useApiJsonOverMock();

type Handler = (url: string, init?: RequestInit) => Response | undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ success: true, data });
const refuse = (message: string, status = 422) => json({ success: false, error: { code: 'VALIDATION_ERROR', message } }, status);

function script(handler: Handler) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => handler(String(url), init) ?? ok({}));
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ENTRY = {
  id: 'te-1', userId: 'u-1', projectName: 'Audit', taskDescription: 'Review ledger', entryDate: localISODate(),
  hours: 2, rate: 500, amount: 1000, billable: true, invoiced: false, customerId: 'c-1', customerName: 'Acme',
  notes: null, status: 'draft',
};

it('timesheets: a refused entry save shows the server message in the toast', async () => {
  const MSG = 'D2 server says no: hours exceed the 24h daily cap for this day';
  script((u, init) => {
    if (u.includes('/time-entries')) return init?.method === 'POST' ? refuse(MSG) : ok({ entries: [] });
    return undefined;
  });
  const { container } = render(<TimesheetsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Add Entry/ }));
  fireEvent.change(await screen.findByPlaceholderText('What did you work on?'), { target: { value: 'Review ledger' } });
  fireEvent.change(screen.getAllByPlaceholderText('0.00')[0]!, { target: { value: '30' } });
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Failed')).toBeNull();
});

it('timesheets: a refused invoice creation shows the server message in the toast', async () => {
  const MSG = 'D2 server says no: customer Acme has no debtors control account';
  script((u, init) => {
    if (u.includes('/time-entries-invoice')) return refuse(MSG);
    if (u.includes('/time-entries')) return init?.method === 'POST' ? undefined : ok({ entries: [ENTRY] });
    return undefined;
  });
  render(<TimesheetsPage />);
  await screen.findByText('Review ledger');
  const boxes = screen.getAllByRole('checkbox');
  fireEvent.click(boxes[boxes.length - 1]!);
  fireEvent.click(await screen.findByRole('button', { name: /Create Invoice \(1\)/ }));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Failed')).toBeNull();
});

it('time tracking: a refused delete shows the server message', async () => {
  const MSG = 'D2 server says no: this entry belongs to a locked timesheet period';
  vi.stubGlobal('confirm', () => true);
  script((u, init) => {
    if (u.includes('/time-entries')) return init?.method === 'DELETE' ? refuse(MSG, 409) : ok({ entries: [ENTRY], total: 1 });
    return undefined;
  });
  render(<TimeTrackingPage />);
  await screen.findByText('Review ledger');
  fireEvent.click(screen.getByTitle('Delete'));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Failed')).toBeNull();
});

it('time tracking: a refused bulk submit shows the server message', async () => {
  const MSG = 'D2 server says no: 1 entry has no project and cannot be submitted';
  script((u) => {
    if (u.includes('/time-entries-action')) return refuse(MSG);
    if (u.includes('/time-entries')) return ok({ entries: [ENTRY], total: 1 });
    return undefined;
  });
  render(<TimeTrackingPage />);
  await screen.findByText('Review ledger');
  fireEvent.click(screen.getAllByRole('checkbox')[1]!);
  fireEvent.click(await screen.findByRole('button', { name: /^Submit$/ }));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Failed')).toBeNull();
});

it('VAT adjustments: a refused create shows the server message', async () => {
  const MSG = 'D2 server says no: VAT period 2026-01 is locked after submission';
  script((u, init) => {
    if (u.includes('/vat-adjustments')) return init?.method === 'POST' ? refuse(MSG, 409) : ok({ items: [] });
    return undefined;
  });
  const { container } = render(<VATAdjustmentsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /New Adjustment/ }));
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Failed')).toBeNull();
});

it('write-offs: a refused create shows the server message', async () => {
  const MSG = 'D2 server says no: write-off exceeds the open balance of invoice INV-9';
  script((u, init) => {
    if (u.includes('/write-offs')) return init?.method === 'POST' ? refuse(MSG) : ok({ items: [] });
    return undefined;
  });
  const { container } = render(<WriteOffsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /New Write-Off/ }));
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Failed')).toBeNull();
});

it('success: timesheets renders the data it received and invoice creation completes', async () => {
  script((u, init) => {
    if (u.includes('/time-entries-invoice')) return ok({ invoiceNumber: 'INV-ZETA-71' });
    if (u.includes('/time-entries')) return init?.method === 'POST' ? undefined : ok({ entries: [ENTRY] });
    return undefined;
  });
  render(<TimesheetsPage />);
  await screen.findByText('Review ledger');
  const boxes = screen.getAllByRole('checkbox');
  fireEvent.click(boxes[boxes.length - 1]!);
  fireEvent.click(await screen.findByRole('button', { name: /Create Invoice \(1\)/ }));
  expect(await screen.findByText('Invoice INV-ZETA-71 created')).toBeTruthy();
});

it('success: time tracking renders the data it received and a bulk submit completes', async () => {
  script((u) => {
    if (u.includes('/time-entries-action')) return ok({ count: 7 });
    if (u.includes('/time-entries')) return ok({ entries: [ENTRY], total: 1 });
    return undefined;
  });
  render(<TimeTrackingPage />);
  await screen.findByText('Review ledger');
  fireEvent.click(screen.getAllByRole('checkbox')[1]!);
  fireEvent.click(await screen.findByRole('button', { name: /^Submit$/ }));
  expect(await screen.findByText('Submitted 7 entries')).toBeTruthy();
});

it('success: VAT adjustments renders the data it received after a create', async () => {
  let created = false;
  const item = { id: 'v-1', adjustmentNumber: 'VA-ZETA-31', adjustmentDate: '2026-01-05', vatPeriod: '2026-01', adjustmentType: 'input', amount: 1234, reason: 'Bad debt', status: 'draft' };
  script((u, init) => {
    if (u.includes('/vat-adjustments')) {
      if (init?.method === 'POST') { created = true; return ok({}); }
      return ok({ items: created ? [item] : [] });
    }
    return undefined;
  });
  const { container } = render(<VATAdjustmentsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /New Adjustment/ }));
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByText('VA-ZETA-31')).toBeTruthy();
});

it('success: write-offs renders the data it received after a create', async () => {
  let created = false;
  const item = { id: 'w-1', writeOffNumber: 'WO-ZETA-52', clientName: 'Zeta Traders', invoiceNumber: 'INV-9', amount: 321, writeOffDate: '2026-01-05', status: 'draft' };
  script((u, init) => {
    if (u.includes('/write-offs')) {
      if (init?.method === 'POST') { created = true; return ok({}); }
      return ok({ items: created ? [item] : [] });
    }
    return undefined;
  });
  const { container } = render(<WriteOffsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /New Write-Off/ }));
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByText('WO-ZETA-52')).toBeTruthy();
  expect(screen.getByText('Zeta Traders')).toBeTruthy();
});
