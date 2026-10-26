/**
 * D2 round 3 (a5): writes on budgets / adjustments / supplier-categories / business-units / customer-allocations.
 * A refused write shows the server's reason and claims no success; an empty-body 500 shows a plain sentence;
 * a write that went through followed by a failing reload still says it went through, clears the stale rows
 * and leaves no stuck spinner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => null }));

import BudgetsPage from '../../../pages/accounting/budgets/index';
import { budgetRow, budgetsPayload } from './budgetsApiFixture';
import AdjustmentsPage from '../../../pages/accounting/adjustments/index';
import SupplierCategoriesPage from '../../../pages/accounting/supplier-categories/index';
import BusinessUnitsPage from '../../../pages/accounting/business-units/index';
import CustomerAllocationsPage from '../../../pages/accounting/customer-allocations/index';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const spinner = () => document.querySelector('.animate-spin');
const click = (el: Element | null) => { expect(el).toBeTruthy(); fireEvent.click(el!); };
/** jsdom does not run the browser's constraint validation for a click; submit the form the button belongs to. */
const submit = (btn: Element) => fireEvent.submit(btn.closest('form')!);

const BUDGET = budgetRow();
const GL = [{ id: 'g1', accountCode: '5000', accountName: 'D2 Rent', accountType: 'expense', isActive: true }];
const budgetsApi = (write: (url: string, m: string) => Response | undefined, reload?: () => Response) => (u: string, m: string) => {
  if (m !== 'GET') return write(u, m);
  if (u.includes('chart-of-accounts')) return ok(GL);
  return reload ? reload() : ok(budgetsPayload([BUDGET]));
};
const budgetsLoaded = async () => { render(<BudgetsPage />); await screen.findByText('D2 Sales Budget'); };

describe('budgets', () => {
  const addBudget = async () => {
    await budgetsLoaded();
    fireEvent.click(screen.getByRole('button', { name: /add budget/i }));
    await screen.findByRole('option', { name: /D2 Rent/ });
    fireEvent.change(screen.getAllByRole('combobox')[1]!, { target: { value: 'g1' } });
    fireEvent.change(screen.getByPlaceholderText('Annual Amount *'), { target: { value: '500' } });
    submit(screen.getByRole('button', { name: /save budget/i }));
  };

  it('save refused: the server message shows, the form stays open, no success', async () => {
    script(budgetsApi(() => refuse()));
    await addBudget();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByRole('button', { name: /save budget/i })).toBeTruthy();
    expect(screen.queryByText('Budget saved')).toBeNull();
  });

  it('save with an empty-body 500: a plain sentence, no bare Failed', async () => {
    script(budgetsApi(() => empty500()));
    await addBudget();
    expect(await screen.findByText('Could not save the budget - try again')).toBeTruthy();
    expectNoRawError();
  });

  it('save 200 then reload 500: still says saved, shows the reload error, rows cleared, no spinner', async () => {
    let saved = false;
    script(budgetsApi(() => { saved = true; return ok({}); }, () => (saved ? empty500() : ok(budgetsPayload([BUDGET])))));
    await addBudget();
    expect(await screen.findByText('Budget saved')).toBeTruthy();
    expect(await screen.findByText('Could not load budgets - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2 Sales Budget')).toBeNull());
    expect(spinner()).toBeNull();
    expectNoRawError();
  });

  it('copy refused / empty 500: the reason shows, no "Copied"', async () => {
    script(budgetsApi(() => refuse()));
    await budgetsLoaded();
    click(screen.getByRole('button', { name: /copy to/i }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    cleanup();
    script(budgetsApi(() => empty500()));
    await budgetsLoaded();
    click(screen.getByRole('button', { name: /copy to/i }));
    expect(await screen.findByText('Could not copy the budgets - try again')).toBeTruthy();
    expect(screen.queryByText(/Copied/)).toBeNull();
    expectNoRawError();
  });

  it('delete refused: the reason shows and the row stays', async () => {
    script(budgetsApi(() => refuse()));
    await budgetsLoaded();
    click(screen.getByTitle('Delete'));
    click(await screen.findByText('Delete')); // delete asks first
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByText('D2 Sales Budget')).toBeTruthy();
    expect(screen.queryByText('Budget deleted')).toBeNull();
  });
});

const ADJ = { id: 'j1', adjustmentNumber: 'D2-ADJ-1', entityType: 'customer', entityId: 'c1', entityName: 'D2 Client', adjustmentType: 'debit', amount: 10, reason: 'r', adjustmentDate: '2026-01-01', status: 'draft' };
const adjApi = (write: (u: string, m: string) => Response | undefined, reload?: () => Response) => (u: string, m: string) => {
  if (m !== 'GET') return write(u, m);
  if (u.includes('/customers')) return ok({ clients: [{ id: 'c1', company_name: 'D2 Client' }] });
  return reload ? reload() : ok({ items: [ADJ] });
};
const adjLoaded = async () => { render(<AdjustmentsPage />); await screen.findByText('D2-ADJ-1'); await screen.findByText('D2 Client'); };

describe('adjustments', () => {
  const create = async () => {
    await adjLoaded();
    click(screen.getByRole('button', { name: /new adjustment/i }));
    await screen.findByRole('option', { name: 'D2 Client' });
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'c1' } });
    fireEvent.change(screen.getByPlaceholderText('Amount *'), { target: { value: '10' } });
    fireEvent.change(screen.getByPlaceholderText('Reason *'), { target: { value: 'because' } });
    submit(screen.getByRole('button', { name: /create adjustment/i }));
  };

  it('create refused: the reason shows, the form stays open', async () => {
    script(adjApi(() => refuse()));
    await create();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByRole('button', { name: /create adjustment/i })).toBeTruthy();
    expectNoRawError();
  });

  it('create with an empty-body 500: a plain sentence', async () => {
    script(adjApi(() => empty500()));
    await create();
    expect(await screen.findByText('Could not create the adjustment - try again')).toBeTruthy();
    expectNoRawError();
  });

  it('approve refused: the reason shows, no approval claimed', async () => {
    script(adjApi(() => refuse()));
    await adjLoaded();
    click(screen.getByTitle('Approve'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('Adjustment approved')).toBeNull();
  });

  it('approve with an empty-body 500: a plain sentence and no stuck spinner', async () => {
    script(adjApi(() => empty500()));
    await adjLoaded();
    click(screen.getByTitle('Approve'));
    expect(await screen.findByText('Could not approve the adjustment - try again')).toBeTruthy();
    expect(spinner()).toBeNull();
  });

  it('approve 200 then reload 500: still says approved, shows the reload error, rows cleared, no spinner', async () => {
    let done = false;
    script(adjApi(() => { done = true; return ok({}); }, () => (done ? empty500() : ok({ items: [ADJ] }))));
    await adjLoaded();
    click(screen.getByTitle('Approve'));
    expect(await screen.findByText('Adjustment approved')).toBeTruthy();
    expect(await screen.findByText('Could not load adjustments - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2-ADJ-1')).toBeNull());
    expect(spinner()).toBeNull();
  });
});

const CAT = { id: 'k1', name: 'D2 Category', description: 'd', supplierCount: 2 };
const catApi = (write: () => Response, reload?: () => Response) => (_u: string, m: string) => (m !== 'GET' ? write() : reload ? reload() : ok([CAT]));
const catLoaded = async () => { const r = render(<SupplierCategoriesPage />); await screen.findByText('D2 Category'); return r; };

describe('supplier categories', () => {
  const save = async () => {
    const { container } = await catLoaded();
    click(screen.getByRole('button', { name: /add category/i }));
    fireEvent.change(screen.getByPlaceholderText('Category name'), { target: { value: 'D2 New' } });
    click(container.querySelector('svg.lucide-check')!.closest('button'));
  };

  it('save refused: the reason shows, the form is kept, no success', async () => {
    script(catApi(refuse));
    await save();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect((screen.getByPlaceholderText('Category name') as HTMLInputElement).value).toBe('D2 New');
    expect(screen.queryByText('Category saved')).toBeNull();
  });

  it('save with an empty-body 500: a plain sentence', async () => {
    script(catApi(empty500));
    await save();
    expect(await screen.findByText('Could not save the category - try again')).toBeTruthy();
    expectNoRawError();
  });

  it('save 200 then reload 500: says saved, shows the reload error, old rows cleared', async () => {
    let done = false;
    script(catApi(() => { done = true; return ok({}); }, () => (done ? empty500() : ok([CAT]))));
    await save();
    expect(await screen.findByText('Category saved')).toBeTruthy();
    expect(await screen.findByText('Could not load supplier categories - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2 Category')).toBeNull());
  });

  it('delete refused: the reason shows and the row stays', async () => {
    vi.stubGlobal('confirm', () => true);
    script(catApi(refuse));
    const { container } = await catLoaded();
    click(container.querySelector('svg.lucide-trash-2, svg.lucide-trash2')!.closest('button'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByText('D2 Category')).toBeTruthy();
    expect(screen.queryByText('Category deleted')).toBeNull();
  });
});

const BU = { id: 'u1', name: 'D2 Finance', code: 'FIN', isActive: true };
const buApi = (write: () => Response, reload?: () => Response) => (_u: string, m: string) => (m !== 'GET' ? write() : reload ? reload() : ok([BU]));

describe('business units', () => {
  const create = async () => {
    render(<BusinessUnitsPage />);
    await screen.findByText('D2 Finance');
    click(screen.getByRole('button', { name: /new business unit/i }));
    fireEvent.change(screen.getByPlaceholderText('Name *'), { target: { value: 'D2 Ops' } });
    fireEvent.change(screen.getByPlaceholderText('Code (e.g. FIN) *'), { target: { value: 'OPS' } });
    click(screen.getByRole('button', { name: 'Create' }));
  };

  it('create refused: the reason shows, the form stays open', async () => {
    script(buApi(refuse));
    await create();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
  });

  it('create with an empty-body 500: a plain sentence, no bare Failed', async () => {
    script(buApi(empty500));
    await create();
    expect(await screen.findByText('Could not save the business unit - try again')).toBeTruthy();
    expectNoRawError();
  });

  it('create 200 then reload 500: says saved, shows the reload error, old rows cleared', async () => {
    let done = false;
    script(buApi(() => { done = true; return ok({}); }, () => (done ? empty500() : ok([BU]))));
    await create();
    expect(await screen.findByText('Business unit saved')).toBeTruthy();
    expect(await screen.findByText('Could not load business units - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2 Finance')).toBeNull());
    expect(spinner()).toBeNull();
  });
});

const PAY = { id: 'p1', paymentNumber: 'D2-RCPT-1', clientName: 'D2 Client', clientId: 'c1', date: '2026-01-01', totalAmount: 100, allocatedAmount: 0 };
const INV = { id: 'i1', invoiceNumber: 'D2-INV-1', date: '2026-01-01', total: 100, outstanding: 100 };
const allocApi = (write: () => Response, reload?: () => Response) => (u: string, m: string) => {
  if (m !== 'GET') return write();
  if (u.includes('customer-invoices')) return ok({ items: [INV] });
  return reload ? reload() : ok([PAY]);
};
const allocate = async () => {
  render(<CustomerAllocationsPage />);
  click(await screen.findByText('D2-RCPT-1'));
  fireEvent.click(await screen.findByRole('checkbox'));
  click(screen.getByRole('button', { name: /allocate/i }));
};

describe('customer allocations', () => {
  it('allocate refused: the reason shows as an error, no success, the receipt stays selected', async () => {
    script(allocApi(refuse));
    await allocate();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('Allocated successfully')).toBeNull();
    expect(screen.queryByText('Allocation failed')).toBeNull();
    expect(screen.getByText('D2-INV-1')).toBeTruthy();
  });

  it('allocate with an empty-body 500: a plain sentence and the Allocate button is usable again', async () => {
    script(allocApi(empty500));
    await allocate();
    expect(await screen.findByText('Could not allocate the receipt - try again')).toBeTruthy();
    expect((screen.getByRole('button', { name: /allocate/i }) as HTMLButtonElement).disabled).toBe(false);
    expectNoRawError();
  });

  it('allocate 200 then reload 500: still says allocated, shows the reload error, old receipts cleared', async () => {
    let done = false;
    script(allocApi(() => { done = true; return ok({}); }, () => (done ? empty500() : ok([PAY]))));
    await allocate();
    expect(await screen.findByText('Allocated successfully')).toBeTruthy();
    expect(await screen.findByText('Could not load receipts - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2-RCPT-1')).toBeNull());
    expect(spinner()).toBeNull();
  });
});
