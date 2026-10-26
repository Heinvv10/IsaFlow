/**
 * The new-asset form must not submit without a purchase date. DateField's `required` only marks the field and
 * errors on blur; it does not block the form, and the assets API does not refuse a missing purchaseDate.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/apiFetch';
import Page from '../../../pages/accounting/assets/new';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => (init?.method === 'POST' ? json({ id: 'a1' }) : json([])));
});

function fillRequired(container: HTMLElement): void {
  fireEvent.change(container.querySelector('input[name="name"]')!, { target: { value: 'Drill' } });
  fireEvent.change(screen.getByLabelText(/^Cost/), { target: { value: '1000' } });
  fireEvent.change(screen.getByLabelText(/^Useful Life/), { target: { value: '5' } });
}

function postCalls(): number {
  return vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST').length;
}

it('blocks submit and shows an error when the purchase date is empty', async () => {
  const { container } = render(<Page />);
  fillRequired(container);
  const date = screen.getByRole('textbox', { name: /purchase date/i });
  fireEvent.change(date, { target: { value: '' } });
  fireEvent.blur(date);
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByText(/enter (the purchase )?date|enter a date/i)).toBeTruthy();
  expect(postCalls()).toBe(0);
});

it('submits once a purchase date such as "1 Oct 2026" is typed', async () => {
  const { container } = render(<Page />);
  fillRequired(container);
  const date = screen.getByRole('textbox', { name: /purchase date/i });
  fireEvent.change(date, { target: { value: '1 Oct 2026' } });
  fireEvent.blur(date);
  fireEvent.submit(container.querySelector('form')!);
  await waitFor(() => expect(postCalls()).toBe(1));
  const body = JSON.parse(String(vi.mocked(apiFetch).mock.calls.find(([, i]) => i?.method === 'POST')![1]!.body));
  expect(body.purchaseDate).toBe('2026-10-01');
});
