/**
 * The company's default payment terms (what a contact with none uses), read once per mount; null until read or when it
 * fails. `enabled` false reads nothing (a field that does not offer "Use company default" has no use for it).
 */
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { readTerms, type Terms } from '@/modules/accounting/services/shared/paymentTerms';

export function useCompanyDefaultTerms(enabled = true): Terms | null {
  const [terms, setTerms] = useState<Terms | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/accounting/company-settings?type=payment-terms');
        if (!res.ok) {
          log.warn('company default terms not loaded', { status: res.status }, 'payment-terms');
          return;
        }
        const json = await res.json() as { data?: { payment_terms?: unknown; payment_terms_type?: unknown } };
        const t = readTerms(Number(json.data?.payment_terms), typeof json.data?.payment_terms_type === 'string' ? json.data.payment_terms_type : null);
        if (!cancelled && t) setTerms(t);
      } catch (err) {
        log.warn('company default terms not loaded', { error: err }, 'payment-terms');
      }
    })();
    return () => { cancelled = true; };
  }, [enabled]);
  return terms;
}
