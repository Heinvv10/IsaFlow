/**
 * D2 round 3 (a4): delivery-note and goods-received creation. A refused create must not redirect; a dispatch that
 * fails after the draft was saved must say so (and not redirect, not create a second draft on retry); the PO list
 * failure must not look like "no purchase orders".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, PLAIN_BAD, empty500, envelope, ok } from '../helpers/d2R3a4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import DeliveryNoteNewPage from '../../../pages/accounting/delivery-notes/new';
import GoodsReceivedNewPage from '../../../pages/accounting/goods-received/new';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.push.mockReset(); });
afterEach(() => { cleanup(); });

const noJsonLeak = () => expect(screen.queryByText(PLAIN_BAD)).toBeNull();
const isWrite = (init?: RequestInit) => !!init?.method && init.method !== 'GET';
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => i?.method === 'POST');

describe('delivery-notes/new', () => {
  const script = (post: () => Response, patch: () => Response = () => ok({})) =>
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (init?.method === 'POST') return post();
      if (init?.method === 'PATCH') return patch();
      return String(url).includes('/customers') ? ok([{ id: 'c1', name: 'D2 Customer' }]) : ok({ orders: [] });
    });
  const fill = async () => {
    await screen.findByRole('option', { name: 'D2 Customer' });
    fireEvent.change(document.querySelector('select[name="customerId"]')!, { target: { value: 'c1' } });
    fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'D2 goods' } });
  };
  const click = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));

  it('a refused create shows the server message and does not redirect', async () => {
    script(() => envelope());
    render(<DeliveryNoteNewPage />);
    await fill();
    click(/Save as Draft/);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(route.push).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByRole('button', { name: /Save as Draft/ }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('a create answered with an empty 500 shows a plain sentence', async () => {
    script(empty500);
    render(<DeliveryNoteNewPage />);
    await fill();
    click(/Save as Draft/);
    expect(await screen.findByText(/Could not save the delivery note - try again/)).toBeTruthy();
    noJsonLeak();
    expect(route.push).not.toHaveBeenCalled();
  });

  it('a successful draft save redirects to the list', async () => {
    script(() => ok({ id: 'dn1' }));
    render(<DeliveryNoteNewPage />);
    await fill();
    click(/Save as Draft/);
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/delivery-notes'));
  });

  it('a failed dispatch after the draft was saved says so and does not redirect', async () => {
    script(() => ok({ id: 'dn1' }), () => envelope());
    render(<DeliveryNoteNewPage />);
    await fill();
    click(/Save & Dispatch/);
    expect(await screen.findByText(new RegExp(`saved as a draft but not dispatched: ${MSG}`))).toBeTruthy();
    expect(route.push).not.toHaveBeenCalled();
  });

  it('retrying Save & Dispatch after a failed dispatch does not create a second draft', async () => {
    let patchOk = false;
    script(() => ok({ id: 'dn1' }), () => (patchOk ? ok({}) : empty500()));
    render(<DeliveryNoteNewPage />);
    await fill();
    click(/Save & Dispatch/);
    expect(await screen.findByText(/saved as a draft but not dispatched/)).toBeTruthy();
    noJsonLeak();
    patchOk = true;
    await waitFor(() => expect((screen.getByRole('button', { name: /Save & Dispatch/ }) as HTMLButtonElement).disabled).toBe(false));
    click(/Save & Dispatch/);
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/delivery-notes'));
    expect(posts().length).toBe(1);
  });

  it('a dispatch that succeeds redirects', async () => {
    script(() => ok({ id: 'dn1' }), () => ok({}));
    render(<DeliveryNoteNewPage />);
    await fill();
    click(/Save & Dispatch/);
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/delivery-notes'));
  });
});

describe('goods-received/new', () => {
  const PO = { id: 'po1', po_number: 'PO-D2-1', supplier_name: 'D2 Supplier' };
  const script = (list: (url: string) => Response, write: () => Response = () => ok({})) =>
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const u = String(url);
      if (isWrite(init)) return write();
      if (u.includes('/purchase-orders/po1')) return ok({ items: [{ id: 'it1', description: 'D2 widget', quantity: 5, quantity_received: 0 }] });
      return list(u);
    });
  const pick = async () => {
    await screen.findAllByRole('option', { name: /PO-D2-1/ });
    fireEvent.change(document.querySelector('select[name="selectedPO"]')!, { target: { value: 'po1' } });
    await screen.findByText('D2 widget');
  };

  it('a refused PO list shows the server message instead of an empty dropdown', async () => {
    script(() => envelope());
    render(<GoodsReceivedNewPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });

  it('an empty-500 PO list shows a plain sentence', async () => {
    script(empty500);
    render(<GoodsReceivedNewPage />);
    expect(await screen.findByText(/Could not load the purchase orders - try again/)).toBeTruthy();
    noJsonLeak();
  });

  it('a refused create shows the server message, does not redirect, clears saving', async () => {
    script(() => ok([PO]), () => envelope());
    render(<GoodsReceivedNewPage />);
    await pick();
    fireEvent.click(screen.getByRole('button', { name: /Create GRN/ }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(route.push).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByRole('button', { name: /Create GRN/ }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('a create answered with an empty 500 shows a plain sentence', async () => {
    script(() => ok([PO]), empty500);
    render(<GoodsReceivedNewPage />);
    await pick();
    fireEvent.click(screen.getByRole('button', { name: /Create GRN/ }));
    expect(await screen.findByText(/Could not create the goods received note - try again/)).toBeTruthy();
    noJsonLeak();
    expect(route.push).not.toHaveBeenCalled();
  });

  it('a network failure on create is shown, not an unhandled rejection, and saving clears', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (isWrite(init)) throw new TypeError('network down');
      return String(url).includes('/purchase-orders/po1') ? ok({ items: [{ id: 'it1', description: 'D2 widget', quantity: 5, quantity_received: 0 }] }) : ok([PO]);
    });
    render(<GoodsReceivedNewPage />);
    await pick();
    fireEvent.click(screen.getByRole('button', { name: /Create GRN/ }));
    expect(await screen.findByText(/Could not create the goods received note - try again/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: /Create GRN/ }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('a successful create redirects to the list', async () => {
    script(() => ok([PO]), () => ok({ id: 'g1' }));
    render(<GoodsReceivedNewPage />);
    await pick();
    fireEvent.click(screen.getByRole('button', { name: /Create GRN/ }));
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/goods-received'));
  });
});
