/** What the supplier and customer forms (and the company default card) do with the terms pair, apart from rendering it. */
import {
  PaymentTermsError, TERMS_NOT_SET, parseTermsWrite,
} from '@/modules/accounting/services/shared/paymentTerms';

/** The form's value for "Immediate". */
export const IMMEDIATE_TERMS = { payment_terms: '0', payment_terms_type: 'invoice_days' } as const;
/** The form's value before anyone has chosen: a new contact must pick (Hein, plan decision 3). */
export const UNCHOSEN_TERMS = { payment_terms: '', payment_terms_type: '' } as const;
/** The form's value for "Use company default": stored as not set (NULL / NULL). */
export const COMPANY_DEFAULT_TERMS = { payment_terms: '', payment_terms_type: TERMS_NOT_SET } as const;

/** The message for a form's terms, or undefined when they can be saved. Unchosen is not savable. */
export function paymentTermsFormError(days: string, type: string): string | undefined {
  if (type === TERMS_NOT_SET) return undefined;
  if (type === '') return 'Choose the payment terms';
  try {
    if (days.trim() === '') return 'Enter the number of days or months';
    const parsed = parseTermsWrite(Number(days), type);
    return parsed.kind === 'set' ? undefined : 'Choose the payment terms';
  } catch (err) {
    if (err instanceof PaymentTermsError) return err.message;
    throw err;
  }
}

/** The body fields a form submits: N as a number, the type as chosen; "use company default" sends the type alone. */
export function paymentTermsBody(days: string, type: string): { payment_terms?: number; payment_terms_type: string } {
  return type === TERMS_NOT_SET ? { payment_terms_type: type } : { payment_terms: Number(days), payment_terms_type: type };
}
