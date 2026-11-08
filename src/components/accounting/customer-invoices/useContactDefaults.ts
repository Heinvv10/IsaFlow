/**
 * useContactDefaults — the new-invoice page's defaults from the picked customer: the due date (which follows the invoice
 * date until edited), the line discount and the VAT mode. It fills only what the user has not touched, and takes a default
 * back out when the customer changes to one without it, so a figure on screen is either the user's or this customer's.
 *
 * What counts as touched: a Due date edit (even one refused, or cleared, or typed and not yet committed), a VAT mode or
 * rate edit, and what a scan filled; the page reports these through `touch`. A line's discount is the customer's while
 * `discountFromDefault` holds: a fresh line starts with it, a priced line keeps it, and `editedLine` drops it when the
 * user sets the discount, or types onto a line with no default on it while no customer is being read. A line's revenue
 * account is the customer's default revenue account (migration 966) while `accountFromDefault` holds: a fresh line starts
 * on it, a change of customer moves it, and `editedLine` drops it the moment the user picks an account, so a user's pick
 * is never overwritten. Neither flag is ever sent (newInvoiceBody).
 *
 * The edit page does not use this: a stored invoice's figures are the invoice. It reads its customer only to warn
 * (useCustomerLookup, vatTypeWarning).
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { describeContactTerms, dueDateWithDefault, readTerms } from '@/modules/accounting/services/shared/paymentTerms';
import type { InvoiceHeaderForm } from './invoiceHeaderForm';
import type { InvoiceLine } from './InvoiceLineItemsTable';
import { taxModeFromVatType, type TaxMode } from './taxMode';
import { useCustomerLookup, type ContactDefaults } from './useCustomerLookup';

const LOAD_FAILED = "Could not load the customer's terms - enter the due date, discount and VAT by hand";
const VAT_HINT: Record<string, string> = { standard: 'standard rate', zero: 'zero-rated', exempt: 'VAT exempt' };
const TYPED_FIELDS: readonly string[] = ['description', 'quantity', 'unitPrice'];

type TouchableField = 'dueDate' | 'taxMode';

/**
 * The user's edit of a line. The discount they set is theirs, and typing onto a line with no default on it makes its zero
 * theirs, unless the customer is still being read: the default it is waiting for has not had its chance yet.
 */
export function editedLine<L extends InvoiceLine>(l: L, field: string, value: string | number, customerPending: boolean): L {
  const stillDefault = field !== 'discount' && (customerPending || l.discount > 0 || !TYPED_FIELDS.includes(field));
  return {
    ...l, [field]: value, discountFromDefault: Boolean(l.discountFromDefault) && stillDefault,
    accountFromDefault: Boolean(l.accountFromDefault) && field !== 'glAccountId',
  };
}

/** "Customer terms: 30 days from invoice date", or the company default's wording when the customer has none. */
function termsHint(d: ContactDefaults): string {
  const words = describeContactTerms(d.terms, d.termsType, d.companyDefault);
  return readTerms(d.terms, d.termsType) ? `Customer terms: ${words}` : words;
}

/** Why the customer's stored default revenue account is not applied (it is kept on the customer, not used). */
function unusableAccountHint(a: ContactDefaults['unusableRevenueAccount']): string | undefined {
  if (!a) return undefined;
  return `The customer's default revenue account ${a.label} is ${a.inactive ? 'inactive' : 'no longer usable'}, so lines start on Default sales.`;
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
  // Set in the event itself: the customer's answer can commit just before a click and its effects run just after, with
  // the old `touched`. Mode and prices change together, so a default landing then would leave gross prices read as ex-VAT.
  const touchedNow = useRef(touched);

  const due = defaults?.known ? dueDateWithDefault(invoiceDate, defaults.terms, defaults.termsType, defaults.companyDefault) : null;
  useEffect(() => {
    if (!defaults || touchedNow.current.dueDate) return;
    setForm((f) => (f.dueDate === (due ?? '') ? f : { ...f, dueDate: due ?? '' }));
  }, [defaults, due, touched.dueDate, setForm]);

  const discount = defaults?.discount ?? 0;
  useEffect(() => {
    if (!defaults) return;
    setLines((ls) => ls.map((l) => (l.discountFromDefault && l.discount !== discount ? { ...l, discount } : l)));
  }, [defaults, discount, setLines]);

  const account = defaults?.revenueAccountId ?? '';
  useEffect(() => {
    if (!defaults) return;
    setLines((ls) => ls.map((l) => (l.accountFromDefault && l.glAccountId !== account ? { ...l, glAccountId: account } : l)));
  }, [defaults, account, setLines]);

  const defaultMode = defaults ? taxModeFromVatType(defaults.vatType) : null;
  useEffect(() => {
    if (!defaults || touchedNow.current.taxMode) return;
    setTaxMode(defaultMode ?? 'exclusive');
  }, [defaults, defaultMode, touched.taxMode, setTaxMode]);

  const touch = useCallback((field: TouchableField) => {
    if (touchedNow.current[field]) return;
    touchedNow.current = { ...touchedNow.current, [field]: true };
    setTouched(touchedNow.current);
  }, []);
  const reset = useCallback(() => {
    forget();
    touchedNow.current = { dueDate: false, taxMode: false };
    setTouched(touchedNow.current);
  }, [forget]);

  return {
    /** What a new line starts on. */
    lineDiscount: discount,
    /** The revenue account a new line starts on ('' = the company default sales account). */
    lineAccount: account,
    hints: {
      dueDate: defaults?.known && due !== null && !touched.dueDate ? termsHint(defaults) : undefined,
      taxMode: defaults && defaultMode !== null && !touched.taxMode ? `From customer: ${VAT_HINT[defaults.vatType ?? '']}` : undefined,
      discount: discount > 0 ? `${discount}% discount from customer` : undefined,
      account: unusableAccountHint(defaults?.unusableRevenueAccount ?? null),
    },
    /** The customer's VAT type, as read; the page weighs it against the effective rate (vatTypeWarning). */
    vatType: defaults?.vatType ?? null,
    pending,
    touch,
    reset,
    error,
  };
}
