/**
 * PaymentTermsField — the terms picker shared by the supplier and customer forms. A new contact has to choose:
 * "Immediate" is pre-selected (suggested), the other kinds ask for N. The value is the form's own two strings
 * (`payment_terms` N, `payment_terms_type`), the shape the contact APIs take.
 */
import React, { useState } from 'react';
import {
  PAYMENT_TERMS_TYPES, PaymentTermsError, describePaymentTerms, normalisePaymentTermsType, parseTermsWrite,
  type PaymentTermsType,
} from '@/modules/accounting/services/shared/paymentTerms';

type Mode = 'immediate' | PaymentTermsType;

export const IMMEDIATE_TERMS = { payment_terms: '0', payment_terms_type: 'invoice_days' } as const;

const OPTION_LABEL: Record<Mode, string> = {
  immediate: 'Immediate (due on the invoice date)',
  invoice_days: 'Days from invoice date',
  statement_days: 'Days after statement (month-end)',
  statement_months: 'Months after statement (month-end)',
};
const SUGGESTED_N: Record<PaymentTermsType, string> = { invoice_days: '30', statement_days: '30', statement_months: '1' };

/** The message for a form's terms, or undefined when they can be saved. */
export function paymentTermsFormError(days: string, type: string): string | undefined {
  try {
    if (days.trim() === '') return 'Enter the number of days or months';
    const parsed = parseTermsWrite(Number(days), type);
    return parsed.kind === 'set' ? undefined : 'Choose the payment terms';
  } catch (err) {
    if (err instanceof PaymentTermsError) return err.message;
    throw err;
  }
}

/** The body fields a form submits: N as a number, the type as chosen. */
export function paymentTermsBody(days: string, type: string): { payment_terms: number; payment_terms_type: string } {
  return { payment_terms: Number(days), payment_terms_type: type };
}

interface Props {
  days: string;
  type: string;
  onChange: (days: string, type: string) => void;
  error?: string;
  inputClass: string;
}

export function PaymentTermsField({ days, type, onChange, error, inputClass }: Props) {
  const kind = normalisePaymentTermsType(type) ?? 'invoice_days';
  const [mode, setMode] = useState<Mode>(days === '0' && kind === 'invoice_days' ? 'immediate' : kind);

  function pick(next: Mode) {
    setMode(next);
    if (next === 'immediate') onChange(IMMEDIATE_TERMS.payment_terms, IMMEDIATE_TERMS.payment_terms_type);
    else onChange(days === '0' || days === '' ? SUGGESTED_N[next] : days, next);
  }

  const summary = error ? null : describePaymentTerms(days.trim() === '' ? null : Number(days), kind);
  return (
    <div>
      <label htmlFor="payment-terms-kind" className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
        Payment Terms<span className="text-red-400 ml-1">*</span>
      </label>
      <div className="flex gap-2">
        {mode !== 'immediate' && (
          <input
            type="number" min="0" max="999" step="1" aria-label="Number of days or months" value={days}
            onChange={(e) => onChange(e.target.value, kind)} className={`${inputClass} w-20`}
          />
        )}
        <select id="payment-terms-kind" value={mode} onChange={(e) => pick(e.target.value as Mode)} className={inputClass}>
          {(['immediate', ...PAYMENT_TERMS_TYPES] as Mode[]).map((m) => (
            <option key={m} value={m}>{OPTION_LABEL[m]}</option>
          ))}
        </select>
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      {summary && <p className="mt-1 text-xs text-[var(--ff-text-tertiary)]">{summary}</p>}
    </div>
  );
}
