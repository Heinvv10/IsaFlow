/**
 * The header of a customer invoice (client, currency, rate, job, notes, four dates) as the new and edit pages hold it,
 * and the date validity the kit's DateField reports. A refused date is null to the page, which cannot tell it from an
 * empty one, so submit is blocked on the reported validity (and on due-before-invoice, which a later edit of the invoice
 * date can create after the Due date field was accepted).
 */
import { useCallback, useState } from 'react';
import type { FieldValidity } from '@/components/ui/useParsedField';
import { localDateFromISO } from '@/lib/dateUtils';

export interface InvoiceHeaderForm {
  clientId: string;
  invoiceDate: string;
  dueDate: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  taxRate: number;
  notes: string;
  currencyCode: string;
  exchangeRate: number;
  projectId: string;
}

export type InvoiceDateKey = 'invoiceDate' | 'dueDate' | 'billingPeriodStart' | 'billingPeriodEnd';
export type Refused = Partial<Record<InvoiceDateKey, string>>;

export function useInvoiceDateValidity() {
  const [refused, setRefused] = useState<Refused>({});
  const report = useCallback((key: InvoiceDateKey, v: FieldValidity) => {
    setRefused((prev) => {
      const next = { ...prev };
      if (v.valid) delete next[key];
      else next[key] = v.reason ?? 'Enter a valid date.';
      return next;
    });
  }, []);
  const clear = useCallback(() => setRefused({}), []);
  return { refused, report, clear };
}

/** `value` when it is a real 'YYYY-MM-DD' (2026-02-30 and "1 Oct 2026" are not), else ''. DateField throws on any other bound. */
export function isoOrEmpty(value: string | null | undefined): string {
  return value && localDateFromISO(value) !== null ? value : '';
}

/** True when both dates are set and the due date falls before the invoice date (a legacy draft, or an edit of the invoice date). */
export function dueBeforeInvoice(form: Pick<InvoiceHeaderForm, 'invoiceDate' | 'dueDate'>): boolean {
  return Boolean(form.invoiceDate && form.dueDate && form.dueDate < form.invoiceDate);
}

/** Why the dates cannot be saved, or null. Shown on screen, never swallowed. */
export function invoiceDateProblem(form: Pick<InvoiceHeaderForm, 'invoiceDate' | 'dueDate'>, refused: Refused): string | null {
  if (Object.keys(refused).length > 0) return 'Fix the dates marked in red before saving';
  if (!form.invoiceDate) return 'Enter the invoice date';
  if (dueBeforeInvoice(form)) return 'The due date must be on or after the invoice date';
  return null;
}
