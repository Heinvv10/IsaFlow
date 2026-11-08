/**
 * useDueDateFollowsTerms — the edit page's due date for a draft whose due date came from terms (payment-terms programme,
 * Part A). While the user has not touched the Due date field, a changed invoice date or customer shows the date the
 * customer's terms (else the company default) give, and moving back to the loaded date and customer shows the stored due
 * date again, so the body the page saves is what is on screen. The server re-dates the same way (shared/draftDueDate.ts).
 *
 * Only a `terms`-sourced date follows: a hand-set, document or legacy one is never moved. Nothing is shown until the
 * customer's terms have been read (`defaults` is null while they are asked, so no other customer's terms are applied).
 *
 * Named limit: to keep the OLD terms date after changing the invoice date, save the date change, then change the due date.
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { dueDateWithDefault } from '@/modules/accounting/services/shared/paymentTerms';
import type { InvoiceHeaderForm } from './invoiceHeaderForm';
import type { ContactDefaults } from './useCustomerLookup';

interface Loaded { invoiceDate: string; clientId: string; dueDate: string; source: string | null }

export function useDueDateFollowsTerms(
  form: InvoiceHeaderForm,
  setForm: Dispatch<SetStateAction<InvoiceHeaderForm>>,
  defaults: ContactDefaults | null,
) {
  const [loaded, setLoadedState] = useState<Loaded | null>(null);
  const [touched, setTouched] = useState(false);
  /** The stored invoice, as the form was filled from it (another invoice, or a reload, starts again). */
  const load = useCallback((l: Loaded) => { setLoadedState(l); setTouched(false); }, []);
  const touch = useCallback(() => setTouched(true), []);

  const follows = loaded?.source === 'terms' && !touched;
  const moved = loaded !== null && (form.invoiceDate !== loaded.invoiceDate || form.clientId !== loaded.clientId);
  const termsDue = follows && moved && defaults?.known && form.invoiceDate
    ? dueDateWithDefault(form.invoiceDate, defaults.terms, defaults.termsType, defaults.companyDefault) : null;
  // Moved and the terms not read yet (or unreadable): leave what is shown. Not moved: the stored date.
  const want = !follows || loaded === null ? null : moved ? termsDue : loaded.dueDate;
  useEffect(() => {
    if (want === null) return;
    setForm((f) => (f.dueDate === want ? f : { ...f, dueDate: want }));
  }, [want, setForm]);

  return { load, touch, hint: termsDue !== null ? 'Recalculated from the customer’s payment terms' : undefined };
}
