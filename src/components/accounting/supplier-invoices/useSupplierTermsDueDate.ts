/**
 * Fills a new supplier invoice's due date, by the same precedence the server uses (ap/billDueDate): the bill's own
 * terms when the user chose them (net30, immediate), else the supplier's terms, else the company default (migration
 * 958). The user (or a scanned document) owns the date once they set it: `claim()` stops any further fill, so a
 * supplier change, an invoice date change or a terms change never overwrites a date someone typed. Until then the
 * date is DERIVED: changing the supplier takes the previous supplier's date out at once and re-derives from the new one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { UUID_RE } from '@/lib/validation';
import {
  companyTermsFromFields, describePaymentTerms, dueDateWithDefault, ownTermsDueDate, readTerms, type Terms,
} from '@/modules/accounting/services/shared/paymentTerms';

interface SupplierTerms { supplierId: string; days: number | null; type: string | null; companyDefault: Terms }

interface Options {
  supplierId: string;
  invoiceDate: string;
  /** The bill's own "Payment Terms" choice: '' (none), 'immediate' or 'netNN'. */
  invoiceTerms: string;
  /** Set the form's due date ('' clears it) and clear any refused text in the date field. */
  apply: (dueDate: string) => void;
}

export function useSupplierTermsDueDate({ supplierId, invoiceDate, invoiceTerms, apply }: Options) {
  const [terms, setTerms] = useState<SupplierTerms | null>(null);
  const [source, setSource] = useState<'bill' | 'supplier' | 'default' | null>(null);
  const claimed = useRef(false);
  const shownFor = useRef('');
  const applyRef = useRef(apply);
  useEffect(() => { applyRef.current = apply; });

  useEffect(() => {
    // A different supplier: its predecessor's derived date goes now (the answer may be slow, or never come).
    if (shownFor.current !== supplierId) {
      if (shownFor.current !== '' && !claimed.current) applyRef.current('');
      shownFor.current = supplierId;
      setSource(null);
    }
    if (!UUID_RE.test(supplierId)) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/suppliers-list?id=${encodeURIComponent(supplierId)}`);
        if (!res.ok) {
          log.warn('Supplier terms lookup answered an error', { status: res.status, supplierId }, 'supplier-invoices-new');
          return;
        }
        const json = await res.json();
        const row = (json.data ?? json) as Record<string, unknown>;
        if (cancelled) return;
        setTerms({
          supplierId,
          days: row.payment_terms === null || row.payment_terms === undefined ? null : Number(row.payment_terms),
          type: typeof row.payment_terms_type === 'string' ? row.payment_terms_type : null,
          companyDefault: companyTermsFromFields(row.company_default_payment_terms, row.company_default_payment_terms_type),
        });
      } catch (err) {
        log.warn('Supplier terms lookup failed', { error: err, supplierId }, 'supplier-invoices-new');
      }
    })();
    return () => { cancelled = true; };
  }, [supplierId]);

  const current = terms !== null && terms.supplierId === supplierId ? terms : null;
  useEffect(() => {
    if (claimed.current) return;
    const own = ownTermsDueDate(invoiceDate, invoiceTerms);
    if (own !== null) { setSource('bill'); applyRef.current(own); return; }
    if (current === null) return;
    const due = dueDateWithDefault(invoiceDate, current.days, current.type, current.companyDefault);
    setSource(readTerms(current.days, current.type) ? 'supplier' : 'default');
    if (due !== null) applyRef.current(due);
  }, [current, invoiceDate, invoiceTerms]);

  const claim = useCallback(() => { claimed.current = true; setSource(null); }, []);
  let note: string | null = null;
  if (source === 'bill') note = "Due date from this bill's payment terms.";
  else if (source === 'supplier' && current) note = `Due date from the supplier's terms: ${describePaymentTerms(current.days, current.type).toLowerCase()}.`;
  else if (source === 'default' && current) {
    note = `Supplier terms not confirmed: due date from the company default (${describePaymentTerms(current.companyDefault.days, current.companyDefault.type).toLowerCase()}).`;
  }
  return { claim, note };
}
