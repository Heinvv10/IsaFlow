/**
 * PR S final review, the edit page:
 * - leaving after "Leave without them?" was confirmed sends nothing as the page goes (the user discarded it);
 * - another invoice opened in place sends the first one's waiting change first, under the first one's id;
 * - a PUT already out with the body is not sent twice as the page goes;
 * - a refusal shown in the same moment as the gate's sticky 409 is cleared stays on screen;
 * - a gate refusal carried from /new stays through autosaves.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, description, DRAFT, ok, puts, refused, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';
import { stashApproveRefusal } from '@/components/accounting/customer-invoices/useApproveAndEmail';

const h = vi.hoisted(() => ({ router: null as null | Record<string, unknown> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => h.router }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

useApiJsonOverMock();
let confirm: ReturnType<typeof vi.fn>;
const original = window.confirm;
beforeEach(() => {
  vi.useFakeTimers();
  const events = routerEvents();
  const navigate = async () => { events.emit('routeChangeStart', '/elsewhere'); return true; };
  h.router = { query: { invoiceId: 'inv-1' }, pathname: '/x', asPath: '/x', isReady: true, events, push: navigate, replace: navigate, beforePopState: () => undefined };
  confirm = vi.fn(() => true);
  window.confirm = confirm as unknown as typeof window.confirm;
  sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); window.confirm = original; vi.mocked(apiFetch).mockReset(); sessionStorage.clear(); });

const settle = async () => { for (let i = 0; i < 6; i++) await advance(0); };
const router = () => h.router as { push: (u: string) => Promise<boolean>; query: Record<string, string> };
const alertText = () => screen.queryAllByRole('alert').map((e) => e.textContent).join(' | ');
async function open() { render(<EditPage />); await settle(); }

describe('leaving', () => {
  it('after "Leave without them?" is confirmed, nothing is sent as the page goes', async () => {
    serveInvoice();
    await open();
    type(description(), 'Thrown away');
    await act(async () => { await router().push('/elsewhere'); });
    expect(confirm).toHaveBeenCalledTimes(1);
    cleanup();
    await settle();
    expect(puts()).toHaveLength(0);
  });

  it('a PUT already out with the body is not sent again as the page goes', async () => {
    let land: (r: Response) => void = () => undefined;
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'PUT' ? new Promise<Response>((r) => { land = r; }) : undefined));
    await open();
    type(description(), 'Out already');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    cleanup();
    await settle();
    land(ok({ updated: true })); // answered: the next page does not wait on it
    await settle();
    expect(puts()).toHaveLength(1);
  });
});

describe('another invoice opened in place', () => {
  it('sends the first one\'s waiting change first, under its own id', async () => {
    serveInvoice((u) => (u.includes('id=inv-2') ? ok({ ...DRAFT, id: 'inv-2', items: [{ description: 'B line', quantity: 1, unit_price: 50, amount: 50 }] }) : undefined));
    const { rerender } = render(<EditPage />);
    await settle();
    type(description(), 'A changed');
    h.router = { ...h.router, query: { invoiceId: 'inv-2' } };
    rerender(<EditPage />);
    await settle();
    expect(puts()).toHaveLength(1);
    expect(bodyOf(puts()[0]!)).toMatchObject({ id: 'inv-1' });
    expect(bodyOf(puts()[0]!).items[0]!.description).toBe('A changed');
    await advance(5_000);
    expect(puts()).toHaveLength(1);
  });
});

describe('refusals on screen', () => {
  it('a refusal shown as the gate\'s sticky 409 is let go stays visible', async () => {
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'POST' ? refused(409, 'Gate says no', { reason: 'APPROVAL_REQUIRED' }) : undefined));
    await open();
    type(description(), 'Saved once');
    await advance(1_500);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(alertText()).toMatch(/Gate says no/);
    type(screen.getAllByLabelText('Quantity')[0]!, '0');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await settle();
    expect(alertText()).toMatch(/needs a quantity above 0/);
  });

  it('a gate refusal carried from /new stays through autosaves', async () => {
    stashApproveRefusal('inv-1', 'Carried gate refusal', 409);
    serveInvoice();
    await open();
    expect(alertText()).toMatch(/Carried gate refusal/);
    type(description(), 'Edited after');
    await advance(1_500);
    await settle();
    expect(alertText()).toMatch(/Carried gate refusal/);
  });
});
