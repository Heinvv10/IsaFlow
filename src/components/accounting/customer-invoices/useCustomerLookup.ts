/**
 * useCustomerLookup — the picked customer's terms, discount and VAT type, for the invoice form. `defaults` is null until
 * a customer is picked; `pending` is true from the pick until the answer, so Save can wait for it. Only the answer for
 * the last customer picked counts. `useContactDefaults` fills the new page from it; the edit page reads it only for the
 * VAT warning, and Save there waits only for a customer changed on the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { discountInput } from '@/modules/accounting/services/ar/invoiceLineAmount';
import { normaliseVatType } from './taxMode';

export interface ContactDefaults {
  terms: number | null;
  termsType: string | null;
  discount: number;
  /** Trimmed and lower-cased (the column is free text); null when the customer has none. */
  vatType: string | null;
}
const NO_DEFAULTS: ContactDefaults = { terms: null, termsType: null, discount: 0, vatType: null };
const LOOKUP_TIMEOUT_MS = 15_000; // Save waits on this: a server that never answers must not leave it grey for good

/** The single-customer GET's row. Anything else (a non-UUID id gets the list) carries no defaults. */
function readDefaults(row: unknown): ContactDefaults {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return NO_DEFAULTS;
  const r = row as { payment_terms?: unknown; payment_terms_type?: unknown; default_discount?: unknown; default_vat_type?: unknown };
  return {
    terms: r.payment_terms === null || r.payment_terms === undefined ? null : Number(r.payment_terms),
    termsType: typeof r.payment_terms_type === 'string' ? r.payment_terms_type : null,
    discount: discountInput(Number(r.default_discount ?? 0)),
    vatType: typeof r.default_vat_type === 'string' ? normaliseVatType(r.default_vat_type) || null : null,
  };
}

export function useCustomerLookup(clientId: string, failedMessage: string) {
  const [defaults, setDefaults] = useState<ContactDefaults | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const lookup = useRef(0);
  useEffect(() => {
    const seq = ++lookup.current;
    setError('');
    setPending(Boolean(clientId));
    if (!clientId) { setDefaults((d) => (d ? NO_DEFAULTS : d)); return; }
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/customers?id=${encodeURIComponent(clientId)}`, { credentials: 'include', signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
        await assertOk(res, failedMessage);
        const json = await res.json() as { data?: unknown };
        if (seq === lookup.current) { setDefaults(readDefaults(json.data ?? json)); setPending(false); }
      } catch (err) {
        if (seq === lookup.current) { setDefaults(NO_DEFAULTS); setPending(false); setError(apiErrorMessage(err, failedMessage)); }
      }
    })();
  }, [clientId, failedMessage]);

  /** Back to before any customer was picked (Save & New). */
  const forget = useCallback(() => {
    lookup.current++;
    setDefaults(null);
    setPending(false);
    setError('');
  }, []);

  return { defaults, pending, error, forget };
}
