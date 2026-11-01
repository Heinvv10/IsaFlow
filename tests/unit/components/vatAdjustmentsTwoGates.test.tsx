/**
 * VAT adjustments has two date gates: the list filter dates and the new-adjustment form date. A refused form date
 * says nothing about the list, and a refused filter date must not stop the form from being submitted.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(async () => true), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Co' } }) }));

import { apiFetch } from '@/lib/apiFetch';
import VatAdjustments from '../../../pages/accounting/vat-adjustments/index';

useApiJsonOverMock();
const item = { id: 'a', adjustmentNumber: 'VA-1', adjustmentDate: '2031-10-05', adjustmentType: 'input', amount: 10, reason: 'r', status: 'draft' };
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => ok(String(url).includes('vat-adjustments') ? { items: [item] } : []));
});
afterEach(cleanup);

const box = (label: string): HTMLInputElement => screen.getByRole('textbox', { name: new RegExp(`^${label}`, 'i') }) as HTMLInputElement;
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
const LIST_NOTICE = /the list below still uses the previous dates/i;

async function openForm(): Promise<HTMLFormElement> {
  render(<VatAdjustments />);
  await screen.findByText('VA-1');
  fireEvent.click(screen.getByRole('button', { name: /new adjustment/i }));
  fireEvent.change(screen.getByPlaceholderText(/amount/i), { target: { value: '5' } });
  fireEvent.change(screen.getByPlaceholderText(/reason/i), { target: { value: 'why' } });
  return screen.getByRole('button', { name: /create adjustment/i }).closest('form')!;
}

describe('vat-adjustments date gates', () => {
  it('a refused form date does not put the list notice up, and still stops the submit', async () => {
    const form = await openForm();
    typeDate(box('Adjustment Date'), '5 Oct 2031');
    typeDate(box('Adjustment Date'), 'zz');
    expect(box('Adjustment Date').getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText(LIST_NOTICE)).toBeNull();
    fireEvent.submit(form);
    await Promise.resolve();
    expect(posts()).toHaveLength(0);
  });

  it.each(['From', 'To'])('a refused %s filter date does not block the form submit', async (label) => {
    const form = await openForm();
    typeDate(box(label), '1 Nov 2031');
    typeDate(box(label), 'zz');
    expect(screen.getByText(LIST_NOTICE)).toBeTruthy();
    fireEvent.submit(form);
    await waitFor(() => expect(posts()).toHaveLength(1));
  });
});
