/**
 * useContactDefaults — the new-invoice page's defaults from the picked customer: the due date (which follows the invoice
 * date until edited), the line discount and the VAT mode. It fills only what the user has not touched, and takes a default
 * back out when the customer changes to one without it, so a figure on screen is either the user's or this customer's.
 *
 * What counts as touched: a Due date edit (even one refused, or cleared), a VAT mode or rate edit, and what a scan filled;
 * the page reports these through `touch`. A line is touched once anything was typed into it (`isUntouchedLine`).
 *
 * The edit page does not use this: a stored invoice's figures are the invoice, and its customer is not re-read.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { discountInput } from '@/modules/accounting/services/ar/invoiceLineAmount';
import { dueDateFromTerms } from '@/modules/accounting/services/ar/paymentTerms';
import type { InvoiceHeaderForm } from './invoiceHeaderForm';
import type { InvoiceLine } from './InvoiceLineItemsTable';
import { taxModeFromVatType, type TaxMode } from './taxMode';

interface ContactDefaults {
  terms: number | null;
  termsType: string | null;
  discount: number;
  vatType: string | null;
}
const NO_DEFAULTS: ContactDefaults = { terms: null, termsType: null, discount: 0, vatType: null };
const LOAD_FAILED = "Could not load the customer's terms - enter the due date, discount and VAT by hand";
const VAT_HINT: Record<string, string> = { standard: 'standard rate', zero: 'zero-rated', exempt: 'VAT exempt' };

type TouchableField = 'dueDate' | 'taxMode';

/** The single-customer GET's row. Anything else (a non-UUID id gets the list) carries no defaults. */
function readDefaults(row: unknown): ContactDefaults {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return NO_DEFAULTS;
  const r = row as { payment_terms?: unknown; payment_terms_type?: unknown; default_discount?: unknown; default_vat_type?: unknown };
  return {
    terms: r.payment_terms === null || r.payment_terms === undefined ? null : Number(r.payment_terms),
    termsType: typeof r.payment_terms_type === 'string' ? r.payment_terms_type : null,
    discount: discountInput(Number(r.default_discount ?? 0)),
    vatType: typeof r.default_vat_type === 'string' ? r.default_vat_type : null,
  };
}

/** Nothing typed into the line, and its discount is still the one last defaulted onto it. */
export const isUntouchedLine = (l: InvoiceLine, defaultedDiscount: number): boolean =>
  !l.description && !l.unitPrice && l.quantity === 1 && l.discount === defaultedDiscount;

function termsLabel(d: ContactDefaults): string {
  const days = `${d.terms} ${d.terms === 1 ? 'day' : 'days'}`;
  return d.termsType === 'end_of_month' ? `end of month + ${days}` : days;
}

interface Args<L extends InvoiceLine> {
  clientId: string;
  invoiceDate: string;
  setForm: Dispatch<SetStateAction<InvoiceHeaderForm>>;
  setLines: Dispatch<SetStateAction<L[]>>;
  setTaxMode: Dispatch<SetStateAction<TaxMode>>;
}

export function useContactDefaults<L extends InvoiceLine>({ clientId, invoiceDate, setForm, setLines, setTaxMode }: Args<L>) {
  // null until a customer is picked: nothing is filled, or taken out, before there is a customer to take it from.
  const [defaults, setDefaults] = useState<ContactDefaults | null>(null);
  const [touched, setTouched] = useState({ dueDate: false, taxMode: false });
  const [error, setError] = useState('');

  const lookup = useRef(0); // only the answer for the last customer picked counts
  useEffect(() => {
    const seq = ++lookup.current;
    setError('');
    if (!clientId) { setDefaults((d) => (d ? NO_DEFAULTS : d)); return; }
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/customers?id=${encodeURIComponent(clientId)}`, { credentials: 'include' });
        await assertOk(res, LOAD_FAILED);
        const json = await res.json() as { data?: unknown };
        if (seq === lookup.current) setDefaults(readDefaults(json.data ?? json));
      } catch (err) {
        if (seq === lookup.current) { setDefaults(NO_DEFAULTS); setError(apiErrorMessage(err, LOAD_FAILED)); }
      }
    })();
  }, [clientId]);

  const due = defaults ? dueDateFromTerms(invoiceDate, defaults.terms, defaults.termsType) : null;
  useEffect(() => {
    if (!defaults || touched.dueDate) return;
    setForm((f) => (f.dueDate === (due ?? '') ? f : { ...f, dueDate: due ?? '' }));
  }, [defaults, due, touched.dueDate, setForm]);

  const defaultedDiscount = useRef(0);
  const discount = defaults?.discount ?? 0;
  useEffect(() => {
    const previous = defaultedDiscount.current;
    if (!defaults || previous === discount) return;
    defaultedDiscount.current = discount;
    setLines((ls) => ls.map((l) => (isUntouchedLine(l, previous) ? { ...l, discount } : l)));
  }, [defaults, discount, setLines]);

  const defaultMode = defaults ? taxModeFromVatType(defaults.vatType) : null;
  useEffect(() => {
    if (!defaults || touched.taxMode) return;
    setTaxMode(defaultMode ?? 'exclusive');
  }, [defaults, defaultMode, touched.taxMode, setTaxMode]);

  const touch = useCallback((field: TouchableField) => setTouched((t) => (t[field] ? t : { ...t, [field]: true })), []);
  const reset = useCallback(() => {
    lookup.current++;
    defaultedDiscount.current = 0;
    setDefaults(null);
    setTouched({ dueDate: false, taxMode: false });
    setError('');
  }, []);

  return {
    /** What a new line starts on. */
    lineDiscount: discount,
    hints: {
      dueDate: defaults && due !== null && !touched.dueDate ? `From customer: ${termsLabel(defaults)}` : undefined,
      taxMode: defaults && defaultMode !== null && !touched.taxMode ? `From customer: ${VAT_HINT[defaults.vatType ?? '']}` : undefined,
      discount: discount > 0 ? `${discount}% discount from customer` : undefined,
    },
    touch,
    reset,
    error,
  };
}
