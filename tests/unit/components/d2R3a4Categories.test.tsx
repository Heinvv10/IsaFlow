/**
 * D2 round 3 (a4): item / customer category admin, recurring transactions and delivery notes list:
 * writes that treated any HTTP response as success (modal closed, form cleared, silent delete).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, PLAIN_BAD, empty500, envelope, ok } from '../helpers/d2R3a4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'co-1' } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));

import { apiFetch } from '@/lib/apiFetch';
import ItemCategoriesPage from '../../../pages/accounting/item-categories/index';
import CustomerCategoriesPage from '../../../pages/accounting/customer-categories/index';
import RecurringTransactionsPage from '../../../pages/accounting/recurring-transactions';
import DeliveryNotesPage from '../../../pages/accounting/delivery-notes/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.stubGlobal('confirm', vi.fn(() => true));
});
afterEach(() => { cleanup(); });

const noJsonLeak = () => expect(screen.queryByText(PLAIN_BAD)).toBeNull();
const icon = (name: string) => document.querySelector(`[class*="lucide-${name}"]`)!.closest('button') as HTMLButtonElement;
const writes = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');

const CAT = { id: 'k1', name: 'D2 Category', description: 'desc', clientCount: 0 };

describe.each([
  { label: 'item categories', Page: ItemCategoriesPage, path: 'item-categories', noun: 'category' },
  { label: 'customer categories', Page: CustomerCategoriesPage, path: 'customer-categories', noun: 'category' },
])('$label', ({ Page, path }) => {
  const script = (write: (m: string) => Response, list: () => Response = () => ok([CAT])) => {
    let written = false;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes(path) && init?.method && init.method !== 'GET') { written = true; return write(init.method); }
      return written ? list() : ok([CAT]);
    });
  };
  const openAdd = async () => {
    fireEvent.click(await screen.findByText(/Add Category/));
    fireEvent.change(screen.getByPlaceholderText('Category name'), { target: { value: 'D2 New' } });
  };

  it('a refused save shows the server message and keeps the form open', async () => {
    script(() => envelope());
    render(<Page />);
    await openAdd();
    fireEvent.click(icon('check'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect((screen.getByPlaceholderText('Category name') as HTMLInputElement).value).toBe('D2 New');
    await waitFor(() => expect(icon('check').disabled).toBe(false));
  });

  it('a save answered with an empty 500 shows a plain sentence and keeps the form', async () => {
    script(empty500);
    render(<Page />);
    await openAdd();
    fireEvent.click(icon('check'));
    expect(await screen.findByText(/Could not save the category - try again/)).toBeTruthy();
    noJsonLeak();
    expect(screen.getByPlaceholderText('Category name')).toBeTruthy();
  });

  it('a save that succeeds closes the form; a failing reload is shown and clears the stale rows, busy is cleared', async () => {
    script(() => ok({}), empty500);
    render(<Page />);
    await openAdd();
    fireEvent.click(icon('check'));
    expect(await screen.findByText(/Could not load categories - try again/)).toBeTruthy();
    expect(screen.queryByPlaceholderText('Category name')).toBeNull();
    expect(screen.queryByText('D2 Category')).toBeNull();
  });

  it('a refused delete shows the server message', async () => {
    script(() => envelope());
    render(<Page />);
    await screen.findByText('D2 Category');
    fireEvent.click(icon('trash'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByText('D2 Category')).toBeTruthy();
  });

  it('a delete answered with an empty 500 shows a plain sentence', async () => {
    script(empty500);
    render(<Page />);
    await screen.findByText('D2 Category');
    fireEvent.click(icon('trash'));
    expect(await screen.findByText(/Could not delete the category - try again/)).toBeTruthy();
    noJsonLeak();
  });

  it('a failed load shows the server message', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => envelope());
    render(<Page />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});

const TEMPLATE = { id: 't1', companyId: 'co-1', name: 'D2 Monthly Rent', entityType: 'journal_entry', templateData: {}, frequency: 'monthly',
  nextRunDate: '2099-01-01', lastRunDate: null, isActive: true, autoPost: false, createdBy: 'u', createdAt: '2026-01-01' };

describe('recurring transactions', () => {
  const script = (write: () => Response, list: () => Response = () => ok([TEMPLATE])) => {
    let written = false;
    vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
      if (init?.method && init.method !== 'GET') { written = true; return write(); }
      return written ? list() : ok([TEMPLATE]);
    });
  };
  const openEdit = async () => { await screen.findByText('D2 Monthly Rent'); fireEvent.click(icon('pen')); };

  it('a refused save keeps the modal open and shows the server message, no reload', async () => {
    script(() => envelope());
    render(<RecurringTransactionsPage />);
    await openEdit();
    fireEvent.click(await screen.findByText('Save Template'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByText('Save Template')).toBeTruthy();
    expect(writes().length).toBe(1);
  });

  it('a save answered with an empty 500 shows a plain sentence and keeps the modal', async () => {
    script(empty500);
    render(<RecurringTransactionsPage />);
    await openEdit();
    fireEvent.click(await screen.findByText('Save Template'));
    expect(await screen.findByText(/Could not save the template - try again/)).toBeTruthy();
    noJsonLeak();
    expect(screen.getByText('Save Template')).toBeTruthy();
  });

  it('a successful save closes the modal; a failing reload is shown and the stale row is cleared', async () => {
    script(() => ok({}), empty500);
    render(<RecurringTransactionsPage />);
    await openEdit();
    fireEvent.click(await screen.findByText('Save Template'));
    expect(await screen.findByText(/Could not load templates - try again/)).toBeTruthy();
    expect(screen.queryByText('Save Template')).toBeNull();
    expect(screen.queryByText('D2 Monthly Rent')).toBeNull();
  });

  it('a refused delete shows the server message and keeps the row', async () => {
    script(() => envelope());
    render(<RecurringTransactionsPage />);
    await screen.findByText('D2 Monthly Rent');
    fireEvent.click(icon('trash'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByText('D2 Monthly Rent')).toBeTruthy();
  });

  it('a delete answered with an empty 500 shows a plain sentence', async () => {
    script(empty500);
    render(<RecurringTransactionsPage />);
    await screen.findByText('D2 Monthly Rent');
    fireEvent.click(icon('trash'));
    expect(await screen.findByText(/Could not delete the template - try again/)).toBeTruthy();
    noJsonLeak();
  });
});

const NOTE = { id: 'n1', deliveryNoteNumber: 'DN-D2-1', customerName: 'D2 Customer', deliveryDate: '2026-01-01', status: 'draft', lineCount: 1 };

describe('delivery notes list', () => {
  const list = (d: unknown) => ok({ notes: d, total: 1 });
  const script = (write: () => Response) => vi.mocked(apiFetch).mockImplementation(async (_u, init) =>
    init?.method && init.method !== 'GET' ? write() : list([NOTE]));

  it('a refused dispatch shows the server message and clears the busy flag', async () => {
    script(() => envelope());
    render(<DeliveryNotesPage />);
    fireEvent.click(await screen.findByTitle('Mark Dispatched'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    await waitFor(() => expect((screen.getByTitle('Mark Dispatched') as HTMLButtonElement).disabled).toBe(false));
  });

  it('a dispatch answered with an empty 500 shows a plain sentence', async () => {
    script(empty500);
    render(<DeliveryNotesPage />);
    fireEvent.click(await screen.findByTitle('Mark Dispatched'));
    expect(await screen.findByText(/Could not update the delivery note - try again/)).toBeTruthy();
    noJsonLeak();
  });

  it('a refused cancel shows the server message', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('window', Object.assign(window, { confirm: vi.fn(() => true) }));
    script(() => envelope());
    render(<DeliveryNotesPage />);
    fireEvent.click(await screen.findByTitle('Cancel'));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });

  it('a failed reload clears the stale rows', async () => {
    let n = 0;
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => {
      if (init?.method === 'PATCH') return ok({});
      return n++ === 0 ? list([NOTE]) : empty500();
    });
    render(<DeliveryNotesPage />);
    fireEvent.click(await screen.findByTitle('Mark Dispatched'));
    expect(await screen.findByText(/Could not load delivery notes - try again/)).toBeTruthy();
    expect(screen.queryByText('DN-D2-1')).toBeNull();
  });
});
