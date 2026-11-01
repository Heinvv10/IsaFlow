/**
 * useContactDefaults — the new-invoice page's defaults from the picked customer: the due date (which follows the invoice
 * date until edited), the line discount and the VAT mode. It fills only what the user has not touched, and takes a default
 * back out when the customer changes to one without it, so a figure on screen is either the user's or this customer's.
 *
 * What counts as touched: a Due date edit (even one refused, or cleared, or typed and not yet committed), a VAT mode or
 * rate edit, and what a scan filled; the page reports these through `touch`. A line's discount is the customer's while
 * `discountFromDefault` holds: a fresh line starts with it, a priced line keeps it, and `editedLine` drops it when the
 * user sets the discount, or types onto a line with no default on it.
 *
 * The edit page does not use this: a stored invoice's figures are the invoice. It reads a changed customer only to warn
 * (useCustomerLookup, vatTypeWarning).
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { dueDateFromTerms } from '@/modules/accounting/services/ar/paymentTerms';
import type { InvoiceHeaderForm } from './invoiceHeaderForm';
import type { InvoiceLine } from './InvoiceLineItemsTable';
import { taxModeFromVatType, type TaxMode } from './taxMode';
import { useCustomerLookup, type ContactDefaults } from './useCustomerLookup';

const LOAD_FAILED = "Could not load the customer's terms - enter the due date, discount and VAT by hand";
const VAT_HINT: Record<string, string> = { standard: 'standard rate', zero: 'zero-rated', exempt: 'VAT exempt' };
const TYPED_FIELDS: readonly string[] = ['description', 'quantity', 'unitPrice'];

type TouchableField = 'dueDate' | 'taxMode';

/** The user's edit of a line. The discount they set is theirs, and typing onto a line with no default on it makes its zero theirs. */
export function editedLine<L extends InvoiceLine>(l: L, field: string, value: string | number): L {
  const stillDefault = field !== 'discount' && (l.discount > 0 || !TYPED_FIELDS.includes(field));
  return { ...l, [field]: value, discountFromDefault: Boolean(l.discountFromDefault) && stillDefault };
}

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
  const { defaults, pending, error, forget } = useCustomerLookup(clientId, LOAD_FAILED);
  const [touched, setTouched] = useState({ dueDate: false, taxMode: false });

  const due = defaults ? dueDateFromTerms(invoiceDate, defaults.terms, defaults.termsType) : null;
  useEffect(() => {
    if (!defaults || touched.dueDate) return;
    setForm((f) => (f.dueDate === (due ?? '') ? f : { ...f, dueDate: due ?? '' }));
  }, [defaults, due, touched.dueDate, setForm]);

  const discount = defaults?.discount ?? 0;
  useEffect(() => {
    if (!defaults) return;
    setLines((ls) => ls.map((l) => (l.discountFromDefault && l.discount !== discount ? { ...l, discount } : l)));
  }, [defaults, discount, setLines]);

  const defaultMode = defaults ? taxModeFromVatType(defaults.vatType) : null;
  useEffect(() => {
    if (!defaults || touched.taxMode) return;
    setTaxMode(defaultMode ?? 'exclusive');
  }, [defaults, defaultMode, touched.taxMode, setTaxMode]);

  const touch = useCallback((field: TouchableField) => setTouched((t) => (t[field] ? t : { ...t, [field]: true })), []);
  const reset = useCallback(() => {
    forget();
    setTouched({ dueDate: false, taxMode: false });
  }, [forget]);

  return {
    /** What a new line starts on. */
    lineDiscount: discount,
    hints: {
      dueDate: defaults && due !== null && !touched.dueDate ? `Customer terms: ${termsLabel(defaults)}` : undefined,
      taxMode: defaults && defaultMode !== null && !touched.taxMode ? `From customer: ${VAT_HINT[defaults.vatType ?? '']}` : undefined,
      discount: discount > 0 ? `${discount}% discount from customer` : undefined,
    },
    /** The customer's VAT type, as read; the page weighs it against the effective rate (vatTypeWarning). */
    vatType: defaults?.vatType ?? null,
    pending,
    touch,
    reset,
    error,
  };
}
