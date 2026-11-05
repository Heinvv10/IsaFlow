/** Company settings → "Default payment terms": loads the company's default, saves it on its own, never offers "use company default". */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, ok, on, refuse, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: { ...toast, info: vi.fn(), warning: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { DefaultPaymentTermsCard } from '@/components/accounting/settings/DefaultPaymentTermsCard';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); toast.success.mockClear(); toast.error.mockClear(); });
afterEach(() => cleanup());

const puts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
const kind = () => screen.getByLabelText(/payment terms/i) as HTMLSelectElement;

describe('DefaultPaymentTermsCard', () => {
  it('shows the company\'s default and saves a changed one with PUT', async () => {
    serve(on('GET', 'type=payment-terms', () => ok({ payment_terms: 30, payment_terms_type: 'invoice_days' })), on('PUT', 'type=payment-terms', () => ok({})));
    render(<DefaultPaymentTermsCard />);
    await waitFor(() => expect(kind().value).toBe('invoice_days'));
    expect((screen.getByLabelText('Number of days or months') as HTMLInputElement).value).toBe('30');
    fireEvent.change(kind(), { target: { value: 'statement_months' } });
    fireEvent.change(screen.getByLabelText('Number of days or months'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Save default terms/ }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(String((puts()[0]![1] as RequestInit).body))).toEqual({ payment_terms: 2, payment_terms_type: 'statement_months' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Default payment terms saved'));
  });

  it('is itself the default: no "use company default" option', async () => {
    serve(on('GET', 'type=payment-terms', () => ok({ payment_terms: 30, payment_terms_type: 'invoice_days' })));
    render(<DefaultPaymentTermsCard />);
    await waitFor(() => expect(kind().value).toBe('invoice_days'));
    expect(screen.queryByRole('option', { name: /use company default/i })).toBeNull();
  });

  it('will not save an empty or out-of-range number', async () => {
    serve(on('GET', 'type=payment-terms', () => ok({ payment_terms: 30, payment_terms_type: 'invoice_days' })), on('PUT', 'type=payment-terms', () => ok({})));
    render(<DefaultPaymentTermsCard />);
    await waitFor(() => expect(kind().value).toBe('invoice_days'));
    fireEvent.change(screen.getByLabelText('Number of days or months'), { target: { value: '1000' } });
    expect((screen.getByRole('button', { name: /Save default terms/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(puts()).toHaveLength(0);
  });

  it('says so when the default cannot be read, and shows no form to save over it', async () => {
    serve(on('GET', 'type=payment-terms', empty500));
    render(<DefaultPaymentTermsCard />);
    expect(await screen.findByText('Could not load the default payment terms - try again')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save default terms/ })).toBeNull();
  });

  it('shows the server\'s refusal on save', async () => {
    serve(on('GET', 'type=payment-terms', () => ok({ payment_terms: 30, payment_terms_type: 'invoice_days' })), on('PUT', 'type=payment-terms', () => refuse('No')));
    render(<DefaultPaymentTermsCard />);
    await waitFor(() => expect(kind().value).toBe('invoice_days'));
    fireEvent.click(screen.getByRole('button', { name: /Save default terms/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });
});
