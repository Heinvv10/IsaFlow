/**
 * PaymentTermsField — the terms picker shared by the supplier and customer forms and the company default card.
 * A contact has to CHOOSE (no pre-selection, Hein 2026-11-05): "Choose…" shows until someone picks, and the form
 * refuses to save on it. "Immediate" and the three kinds (which ask for N) are choices; so is "Use company default"
 * (`allowDefault`: N empty, type `not_set`, stored as NULL / NULL, the company's terms apply to new documents).
 * The value is the form's own two strings (`payment_terms` N, `payment_terms_type`), the shape the contact APIs take.
 */
import { useState } from 'react';
import {
  PAYMENT_TERMS_TYPES, TERMS_NOT_SET, describePaymentTerms, normalisePaymentTermsType, type PaymentTermsType,
} from '@/modules/accounting/services/shared/paymentTerms';
import { COMPANY_DEFAULT_TERMS, IMMEDIATE_TERMS, paymentTermsFormError } from './paymentTermsForm';
import { useCompanyDefaultTerms } from './useCompanyDefaultTerms';

type Mode = 'choose' | 'immediate' | 'default' | PaymentTermsType;

const OPTION_LABEL: Record<Exclude<Mode, 'choose' | 'default'>, string> = {
  immediate: 'Immediate',
  invoice_days: 'Days from invoice',
  statement_days: 'Days after statement',
  statement_months: 'Months after statement',
};
const SUGGESTED_N: Record<PaymentTermsType, string> = { invoice_days: '30', statement_days: '30', statement_months: '1' };

interface Props {
  days: string;
  type: string;
  onChange: (days: string, type: string) => void;
  error?: string;
  inputClass: string;
  /** Offer "Use company default" (the contact forms). The company's own default is always a real choice. */
  allowDefault?: boolean;
}

function initialMode(days: string, type: string): Mode {
  if (type === '') return 'choose';
  if (type === TERMS_NOT_SET) return 'default';
  const kind = normalisePaymentTermsType(type) ?? 'invoice_days';
  return days === '0' && kind === 'invoice_days' ? 'immediate' : kind;
}

export function PaymentTermsField({ days, type, onChange, error: parentError, inputClass, allowDefault = false }: Props) {
  // The page's message stays until its next save; once the value is fixable it is no longer true, so it goes.
  const error = parentError && paymentTermsFormError(days, type) ? parentError : undefined;
  const kind = normalisePaymentTermsType(type) ?? 'invoice_days';
  const [mode, setMode] = useState<Mode>(initialMode(days, type));
  const companyDefault = useCompanyDefaultTerms();

  function pick(next: Mode) {
    setMode(next);
    if (next === 'choose') onChange('', '');
    else if (next === 'default') onChange(COMPANY_DEFAULT_TERMS.payment_terms, COMPANY_DEFAULT_TERMS.payment_terms_type);
    else if (next === 'immediate') onChange(IMMEDIATE_TERMS.payment_terms, IMMEDIATE_TERMS.payment_terms_type);
    else onChange(days === '0' || days === '' ? SUGGESTED_N[next] : days, next);
  }

  const defaultWords = companyDefault ? describePaymentTerms(companyDefault.days, companyDefault.type) : null;
  let summary: string | null = null;
  if (!error && mode === 'default') {
    summary = defaultWords ? `Terms not confirmed: new documents use the company default (${defaultWords}).` : 'Terms not confirmed: new documents use the company default.';
  } else if (!error && mode !== 'choose') {
    summary = describePaymentTerms(days.trim() === '' ? null : Number(days), kind);
  }
  const showNumber = mode !== 'choose' && mode !== 'immediate' && mode !== 'default';

  return (
    <div>
      <label htmlFor="payment-terms-kind" className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
        Payment Terms<span className="text-red-400 ml-1">*</span>
      </label>
      <div className="flex gap-2">
        {showNumber && (
          <input
            type="number" min="0" max="999" step="1" aria-label="Number of days or months" value={days}
            onChange={(e) => onChange(e.target.value, kind)} className={inputClass.replace('w-full', 'w-20 shrink-0')}
          />
        )}
        <select id="payment-terms-kind" value={mode} onChange={(e) => pick(e.target.value as Mode)} className={inputClass.replace('w-full', 'min-w-0 flex-1')}>
          {mode === 'choose' && <option value="choose">Choose…</option>}
          <option value="immediate">{OPTION_LABEL.immediate}</option>
          {PAYMENT_TERMS_TYPES.map((t) => <option key={t} value={t}>{OPTION_LABEL[t]}</option>)}
          {allowDefault && <option value="default">Use company default{defaultWords ? ` (${defaultWords})` : ''}</option>}
        </select>
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      {summary && <p className="mt-1 text-xs text-[var(--ff-text-tertiary)]">{summary}</p>}
    </div>
  );
}
