/**
 * useCustomerLookup — the picked customer's terms, discount and VAT type, for the invoice form. `defaults` is null until
 * a customer is picked; `pending` is true from the pick until the answer, so Save can wait for it. Only the answer for
 * the last customer picked counts. `useContactDefaults` fills the new page from it; the edit page reads it only for the
 * VAT warning, and Save there waits only for a customer changed on the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { discountInput } from '@/modules/accounting/services/ar/invoiceLineAmount';
import { FALLBACK_COMPANY_TERMS, companyTermsFromFields, type Terms } from '@/modules/accounting/services/shared/paymentTerms';
import { normaliseVatType } from './taxMode';

export interface ContactDefaults {
  /** False when the customer could not be read (or the answer was not a customer): nothing is known, so no terms are applied. */
  known: boolean;
  terms: number | null;
  termsType: string | null;
  /** The company's default terms: what a customer with none is dated by. */
  companyDefault: Terms;
  discount: number;
  /** Trimmed and lower-cased (the column is free text); null when the customer has none. */
  vatType: string | null;
  /** The customer's default revenue account id (migration 966); null when it has none or it can no longer be used. */
  revenueAccountId: string | null;
  /** A stored default that can no longer be used (deactivated, re-typed, given sub-accounts): its label and why. */
  unusableRevenueAccount: { label: string; inactive: boolean } | null;
}
const NO_DEFAULTS: ContactDefaults = { known: false, terms: null, termsType: null, companyDefault: FALLBACK_COMPANY_TERMS, discount: 0, vatType: null, revenueAccountId: null, unusableRevenueAccount: null };
const LOOKUP_TIMEOUT_MS = 15_000; // Save waits on this: a server that never answers must not leave it grey for good

/** The GET's `default_revenue_account` view: used only while `usable`; otherwise named, so the page can say why not. */
function revenueAccountOf(view: unknown): Pick<ContactDefaults, 'revenueAccountId' | 'unusableRevenueAccount'> {
  const v = typeof view === 'object' && view !== null ? view as { id?: unknown; label?: unknown; usable?: unknown; problem?: unknown } : {};
  if (typeof v.id !== 'string' || !v.id) return { revenueAccountId: null, unusableRevenueAccount: null };
  if (v.usable === true) return { revenueAccountId: v.id, unusableRevenueAccount: null };
  return { revenueAccountId: null, unusableRevenueAccount: { label: typeof v.label === 'string' ? v.label : v.id, inactive: v.problem === 'is inactive' } };
}

/** The single-customer GET's row. Anything else (a non-UUID id gets the list) carries no defaults. */
function readDefaults(row: unknown): ContactDefaults {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return NO_DEFAULTS;
  const r = row as {
    payment_terms?: unknown; payment_terms_type?: unknown; default_discount?: unknown; default_vat_type?: unknown;
    company_default_payment_terms?: unknown; company_default_payment_terms_type?: unknown; default_revenue_account?: unknown;
  };
  return {
    known: true,
    terms: r.payment_terms === null || r.payment_terms === undefined ? null : Number(r.payment_terms),
    termsType: typeof r.payment_terms_type === 'string' ? r.payment_terms_type : null,
    companyDefault: companyTermsFromFields(r.company_default_payment_terms, r.company_default_payment_terms_type),
    discount: discountInput(Number(r.default_discount ?? 0)),
    vatType: typeof r.default_vat_type === 'string' ? normaliseVatType(r.default_vat_type) || null : null,
    ...revenueAccountOf(r.default_revenue_account),
  };
}

export function useCustomerLookup(clientId: string, failedMessage: string) {
  const [defaults, setDefaults] = useState<ContactDefaults | null>(null);
  // The customer the last answer was for, cleared by every change of customer (back to the same one included) in the
  // render that makes it. `pending` is derived from it in render, not set in the effect: an effect runs a commit after
  // the pick, and in between Save was drawn enabled with the customer's defaults unasked.
  const [answeredFor, setAnsweredFor] = useState<string | null>(null);
  const [askedFor, setAskedFor] = useState(clientId);
  // Another customer's defaults are not this one's: none while its own are asked (a new line's discount, the VAT warning).
  if (askedFor !== clientId) { setAskedFor(clientId); setAnsweredFor(null); if (clientId) setDefaults(null); }
  const [error, setError] = useState('');
  const [asks, setAsks] = useState(0); // forget() asks again for a customer still picked, so pending cannot stick

  const lookup = useRef(0);
  useEffect(() => {
    const seq = ++lookup.current;
    setError('');
    if (!clientId) { setDefaults((d) => (d ? NO_DEFAULTS : d)); return; }
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/customers?id=${encodeURIComponent(clientId)}`, { credentials: 'include', signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
        await assertOk(res, failedMessage);
        const json = await res.json() as { data?: unknown };
        if (seq === lookup.current) { setDefaults(readDefaults(json.data ?? json)); setAnsweredFor(clientId); }
      } catch (err) {
        if (seq === lookup.current) { setDefaults(NO_DEFAULTS); setAnsweredFor(clientId); setError(apiErrorMessage(err, failedMessage)); }
      }
    })();
  }, [clientId, failedMessage, asks]);

  /** Back to before any customer was picked (Save & New). */
  const forget = useCallback(() => {
    lookup.current++;
    setDefaults(null);
    setAnsweredFor(null);
    setError('');
    setAsks((n) => n + 1);
  }, []);

  const pending = Boolean(clientId) && answeredFor !== clientId;
  return { defaults, pending, error, forget };
}
