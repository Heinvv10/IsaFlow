/**
 * Fills a new supplier invoice's due date from the chosen supplier's payment terms and the invoice date. The user (or
 * a scanned document) owns the date once they set it: `claim()` stops any further fill, so a supplier change or an
 * invoice date change never overwrites a date someone typed. A supplier whose terms are not set leaves the date alone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { UUID_RE } from '@/lib/validation';
import { describePaymentTerms, dueDateFromTerms } from '@/modules/accounting/services/shared/paymentTerms';

interface SupplierTerms { supplierId: string; days: number | null; type: string | null }

interface Options {
  supplierId: string;
  invoiceDate: string;
  /** Set the form's due date (and clear any refused text in the date field). */
  apply: (dueDate: string) => void;
}

export function useSupplierTermsDueDate({ supplierId, invoiceDate, apply }: Options) {
  const [terms, setTerms] = useState<SupplierTerms | null>(null);
  const [filled, setFilled] = useState(false);
  const claimed = useRef(false);
  const applyRef = useRef(apply);
  useEffect(() => { applyRef.current = apply; });

  useEffect(() => {
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
        const row = (json.data ?? json) as { payment_terms?: unknown; payment_terms_type?: unknown };
        if (cancelled) return;
        setTerms({
          supplierId,
          days: row.payment_terms === null || row.payment_terms === undefined ? null : Number(row.payment_terms),
          type: typeof row.payment_terms_type === 'string' ? row.payment_terms_type : null,
        });
      } catch (err) {
        log.warn('Supplier terms lookup failed', { error: err, supplierId }, 'supplier-invoices-new');
      }
    })();
    return () => { cancelled = true; };
  }, [supplierId]);

  const current = terms !== null && terms.supplierId === supplierId ? terms : null;
  useEffect(() => {
    if (current === null || claimed.current) return;
    const due = dueDateFromTerms(invoiceDate, current.days, current.type);
    setFilled(due !== null);
    if (due !== null) applyRef.current(due);
  }, [current, invoiceDate]);

  const claim = useCallback(() => { claimed.current = true; setFilled(false); }, []);
  let note: string | null = null;
  if (current !== null && filled) note = `Due date from the supplier's terms: ${describePaymentTerms(current.days, current.type).toLowerCase()}.`;
  else if (current !== null && current.days === null) note = "This supplier's payment terms are not set: enter the due date.";
  return { claim, note };
}
