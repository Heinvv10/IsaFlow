// Admin Flow Bundles (WP13, admin audit 2026-11-14):
//  - the price is typed in rands and sent as cents (it was typed in cents, unlike Plans), parsed from the string
//    with at most 2 decimals; flows are a whole number;
//  - a double click on Create creates one bundle, not two (4.17);
//  - Deactivate asks first (3.7).
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import FlowBundlesPage from '../../../pages/admin/billing/flow-bundles';
import { randsToCents } from '@/components/admin/billing/randsToCents';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
let releasePost: () => void = () => undefined;

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      await new Promise<void>((r) => { releasePost = r; });
      return ok({ id: 'b-new' });
    }
    if (init?.method === 'PATCH') return ok({});
    return ok({ bundles: [{ id: 'b-1', name: 'Small', flows: 100, priceCents: 5000, isActive: true, displayOrder: 1 }] });
  });
});
afterEach(() => { cleanup(); });
const calls = (method: string) => vi.mocked(apiFetch).mock.calls.filter(([, i]) => i?.method === method);

describe('flow bundles', () => {
  it('sends a rand price as cents, once, however often Create is clicked', async () => {
    render(<FlowBundlesPage />);
    await screen.findByText('Small');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Large' } });
    fireEvent.change(screen.getByLabelText('Flows'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('Price (R)'), { target: { value: '450.50' } });
    const create = screen.getByRole('button', { name: /create/i });
    fireEvent.click(create);
    fireEvent.click(create);
    await waitFor(() => expect(calls('POST')).toHaveLength(1));
    fireEvent.click(create);
    releasePost();
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    expect(calls('POST')).toHaveLength(1);
    expect(JSON.parse(String(calls('POST')[0]![1]?.body))).toMatchObject({ name: 'Large', flows: 1000, priceCents: 45050 });
  });

  it('Deactivate changes nothing until confirmed', async () => {
    render(<FlowBundlesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls('PATCH')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(calls('PATCH')).toHaveLength(1));
    expect(JSON.parse(String(calls('PATCH')[0]![1]?.body))).toEqual({ isActive: false });
  });

  it.each([['1.005'], ['-1'], ['12,50'], ['abc']])('refuses price %s and sends nothing', async (price) => {
    render(<FlowBundlesPage />);
    await screen.findByText('Small');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Odd' } });
    fireEvent.change(screen.getByLabelText('Flows'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Price (R)'), { target: { value: price } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(await screen.findByText(/at most 2 decimals/)).toBeTruthy();
    expect(calls('POST')).toHaveLength(0);
  });

  it('refuses a fractional number of flows', async () => {
    render(<FlowBundlesPage />);
    await screen.findByText('Small');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Odd' } });
    fireEvent.change(screen.getByLabelText('Flows'), { target: { value: '1.5' } });
    fireEvent.change(screen.getByLabelText('Price (R)'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(await screen.findByText(/whole number of flows/)).toBeTruthy();
    expect(calls('POST')).toHaveLength(0);
  });
});

describe('randsToCents', () => {
  it.each([['12.50', 1250], ['12.5', 1250], ['12', 1200], ['0.01', 1], ['0', 0], ['4.35', 435], ['1.15', 115], [' 7 ', 700], ['999999999.99', 99999999999]])(
    '%s -> %d cents', (input, cents) => { expect(randsToCents(input)).toBe(cents); });
  it.each([['1.005'], [''], ['-1'], ['1e3'], ['.5'], ['12,50'], ['1000000000'], ['12345678901234567890.01']])('%j -> null', (input) => { expect(randsToCents(input)).toBeNull(); });
});
