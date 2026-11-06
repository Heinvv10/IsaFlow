/**
 * The terms picker on the supplier and customer forms: a new contact has to CHOOSE (no pre-selection: Hein, 2026-11-05).
 * "Choose…" shows until someone picks; Immediate and the kinds are choices; so is "Use company default", which stores
 * not set (the company's terms then date new documents). The form's own two strings carry the choice.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PaymentTermsField } from '@/components/accounting/PaymentTermsField';
import { paymentTermsBody, paymentTermsFormError, UNCHOSEN_TERMS } from '@/components/accounting/paymentTermsForm';
import { INITIAL_SUPPLIER_FORM } from '@/components/accounting/SupplierForm';
import { INITIAL_CUSTOMER_FORM } from '@/components/accounting/CustomerForm';

vi.mock('@/lib/apiFetch', async () => {
  const real = await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch');
  return { ...real, apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { payment_terms: 30, payment_terms_type: 'invoice_days' } }), { status: 200 })) };
});

function Harness({ onValue, start = UNCHOSEN_TERMS, allowDefault = true }: {
  onValue: (days: string, type: string) => void; start?: { payment_terms: string; payment_terms_type: string }; allowDefault?: boolean;
}) {
  const [v, setV] = useState({ days: start.payment_terms, type: start.payment_terms_type });
  return (
    <PaymentTermsField
      days={v.days} type={v.type} inputClass="x" allowDefault={allowDefault}
      onChange={(days, type) => { setV({ days, type }); onValue(days, type); }}
    />
  );
}

const kind = () => screen.getByLabelText(/payment terms/i) as HTMLSelectElement;

describe('PaymentTermsField', () => {
  it('both new-contact forms start unchosen: nothing is pre-selected, not Immediate and not 30', () => {
    for (const form of [INITIAL_SUPPLIER_FORM, INITIAL_CUSTOMER_FORM]) {
      expect(form.payment_terms).toBe('');
      expect(form.payment_terms_type).toBe('');
    }
  });

  it('shows "Choose…" with no number box until something is picked', () => {
    render(<Harness onValue={vi.fn()} />);
    expect(kind().value).toBe('choose');
    expect(screen.getByRole('option', { name: 'Choose…' })).toBeTruthy();
    expect(screen.queryByLabelText('Number of days or months')).toBeNull();
  });

  it('Immediate is a choice: it emits 0 invoice days and says so', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(kind(), { target: { value: 'immediate' } });
    expect(onValue).toHaveBeenLastCalledWith('0', 'invoice_days');
    expect(screen.getByText('Immediate', { selector: 'p' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Choose…' })).toBeNull();
  });

  it.each([
    ['invoice_days', '30', '30 days from invoice date'],
    ['statement_days', '30', '30 days after statement'],
    ['statement_months', '1', '1 month after statement'],
  ])('choosing %s asks for N, suggests %s and emits the pair', (type, suggested, words) => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(kind(), { target: { value: type } });
    expect(onValue).toHaveBeenLastCalledWith(suggested, type);
    expect((screen.getByLabelText('Number of days or months') as HTMLInputElement).value).toBe(suggested);
    expect(screen.getByText(words)).toBeTruthy();
  });

  it('typing N emits it with the chosen type', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(kind(), { target: { value: 'statement_months' } });
    fireEvent.change(screen.getByLabelText('Number of days or months'), { target: { value: '3' } });
    expect(onValue).toHaveBeenLastCalledWith('3', 'statement_months');
    expect(screen.getByText('3 months after statement')).toBeTruthy();
  });

  it('"Use company default" is a choice that stores not set, and names the company default', async () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Use company default (30 days from invoice date)' })).toBeTruthy());
    fireEvent.change(kind(), { target: { value: 'default' } });
    expect(onValue).toHaveBeenLastCalledWith('', 'not_set');
    expect(screen.queryByLabelText('Number of days or months')).toBeNull();
    expect(screen.getByText('Terms not confirmed: new documents use the company default (30 days from invoice date).')).toBeTruthy();
  });

  it('the company default card offers no "use company default" (it IS the default)', () => {
    render(<Harness onValue={vi.fn()} allowDefault={false} />);
    expect(screen.queryByRole('option', { name: /use company default/i })).toBeNull();
  });

  it('going back to Immediate after a kind resets to 0 invoice days', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(kind(), { target: { value: 'statement_days' } });
    fireEvent.change(kind(), { target: { value: 'immediate' } });
    expect(onValue).toHaveBeenLastCalledWith('0', 'invoice_days');
  });

  it('an edit form opens on what is stored: a legacy days row, and not set as "Use company default"', () => {
    const { unmount } = render(<Harness onValue={vi.fn()} start={{ payment_terms: '45', payment_terms_type: 'invoice_days' }} />);
    expect(kind().value).toBe('invoice_days');
    unmount();
    render(<Harness onValue={vi.fn()} start={{ payment_terms: '', payment_terms_type: 'not_set' }} />);
    expect(kind().value).toBe('default');
  });
});

describe('a stale page error', () => {
  it('goes once the terms are chosen, and stays while they are not', () => {
    const { rerender } = render(<PaymentTermsField days="" type="" inputClass="x" error="Choose the payment terms" onChange={vi.fn()} />);
    expect(screen.getByText('Choose the payment terms')).toBeTruthy();
    rerender(<PaymentTermsField days="" type="not_set" inputClass="x" allowDefault error="Choose the payment terms" onChange={vi.fn()} />);
    expect(screen.queryByText('Choose the payment terms')).toBeNull();
  });
});

describe('paymentTermsFormError / paymentTermsBody', () => {
  it('accepts a whole number with a known type, and the company default', () => {
    expect(paymentTermsFormError('0', 'invoice_days')).toBeUndefined();
    expect(paymentTermsFormError('3', 'statement_months')).toBeUndefined();
    expect(paymentTermsFormError('', 'not_set')).toBeUndefined();
    expect(paymentTermsBody('3', 'statement_months')).toEqual({ payment_terms: 3, payment_terms_type: 'statement_months' });
    expect(paymentTermsBody('', 'not_set')).toEqual({ payment_terms_type: 'not_set' });
  });

  it('refuses unchosen terms: a new contact must pick', () => {
    expect(paymentTermsFormError('', '')).toBe('Choose the payment terms');
  });

  it.each([['', 'invoice_days'], ['-1', 'invoice_days'], ['1.5', 'invoice_days'], ['abc', 'invoice_days'], ['1000', 'invoice_days'], ['30', 'net']])(
    'refuses %j / %s',
    (days, type) => { expect(paymentTermsFormError(days, type)).toBeTruthy(); },
  );

  it('reads the company default only when it offers "Use company default"', async () => {
    const { apiFetch } = await import('@/lib/apiFetch');
    vi.mocked(apiFetch).mockClear();
    const off = render(<Harness onValue={vi.fn()} allowDefault={false} />);
    await new Promise((r) => { setTimeout(r, 20); });
    expect(apiFetch).not.toHaveBeenCalled();
    off.unmount();
    render(<Harness onValue={vi.fn()} allowDefault />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  });
});
