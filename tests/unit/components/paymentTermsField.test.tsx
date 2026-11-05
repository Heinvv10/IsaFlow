/**
 * The terms picker on the supplier and customer forms: a new contact starts on Immediate (suggested, not silently
 * 30), the other kinds ask for N, and the form's own two strings carry the choice.
 */
import { describe, it, expect, vi } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PaymentTermsField, paymentTermsBody, paymentTermsFormError } from '@/components/accounting/PaymentTermsField';
import { INITIAL_SUPPLIER_FORM } from '@/components/accounting/SupplierForm';
import { INITIAL_CUSTOMER_FORM } from '@/components/accounting/CustomerForm';

function Harness({ onValue }: { onValue: (days: string, type: string) => void }) {
  const [v, setV] = useState({ days: '0', type: 'invoice_days' });
  return (
    <PaymentTermsField
      days={v.days} type={v.type} inputClass="x"
      onChange={(days, type) => { setV({ days, type }); onValue(days, type); }}
    />
  );
}

const kind = () => screen.getByLabelText(/payment terms/i) as HTMLSelectElement;

describe('PaymentTermsField', () => {
  it('both new-contact forms start on Immediate, not 30 days', () => {
    for (const form of [INITIAL_SUPPLIER_FORM, INITIAL_CUSTOMER_FORM]) {
      expect(form.payment_terms).toBe('0');
      expect(form.payment_terms_type).toBe('invoice_days');
    }
  });

  it('shows Immediate with no number box, and says so', () => {
    render(<Harness onValue={vi.fn()} />);
    expect(kind().value).toBe('immediate');
    expect(screen.queryByLabelText('Number of days or months')).toBeNull();
    // The summary line under the picker, not the option of the same name.
    expect(screen.getByText('Immediate', { selector: 'p' })).toBeTruthy();
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

  it('going back to Immediate resets to 0 invoice days', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(kind(), { target: { value: 'statement_days' } });
    fireEvent.change(kind(), { target: { value: 'immediate' } });
    expect(onValue).toHaveBeenLastCalledWith('0', 'invoice_days');
  });
});

describe('paymentTermsFormError / paymentTermsBody', () => {
  it('accepts a whole number with a known type', () => {
    expect(paymentTermsFormError('0', 'invoice_days')).toBeUndefined();
    expect(paymentTermsFormError('3', 'statement_months')).toBeUndefined();
    expect(paymentTermsBody('3', 'statement_months')).toEqual({ payment_terms: 3, payment_terms_type: 'statement_months' });
  });

  it.each([['', 'invoice_days'], ['-1', 'invoice_days'], ['1.5', 'invoice_days'], ['abc', 'invoice_days'], ['1000', 'invoice_days'], ['30', 'net']])(
    'refuses %j / %s',
    (days, type) => { expect(paymentTermsFormError(days, type)).toBeTruthy(); },
  );
});
