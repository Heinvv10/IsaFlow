/**
 * "Default payment terms" on the company settings page: what a customer or supplier whose own terms are not set is
 * dated by on a NEW document (invoice, bill, recurring run, import). Saved on its own (PUT company-settings?type=payment-terms),
 * so it never rides on the page's company Save. Starts at 30 days from invoice for every company (migration 958).
 */
import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { PaymentTermsField } from '@/components/accounting/PaymentTermsField';
import { paymentTermsBody, paymentTermsFormError } from '@/components/accounting/paymentTermsForm';

const inputClass = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';
const URL = '/api/accounting/company-settings?type=payment-terms';

export function DefaultPaymentTermsCard() {
  const [terms, setTerms] = useState<{ days: string; type: string } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(URL);
        await assertOk(res, 'Could not load the default payment terms - try again');
        const json = await res.json() as { data?: { payment_terms?: number; payment_terms_type?: string } };
        if (!cancelled) setTerms({ days: String(json.data?.payment_terms ?? ''), type: json.data?.payment_terms_type ?? '' });
      } catch (err) {
        if (!cancelled) { setTerms(null); setLoadError(apiErrorMessage(err, 'Could not load the default payment terms - try again')); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const error = terms ? paymentTermsFormError(terms.days, terms.type) : undefined;

  async function save() {
    if (!terms || error) return;
    setSaving(true);
    try {
      const res = await apiFetch(URL, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(paymentTermsBody(terms.days, terms.type)),
      });
      await assertOk(res, 'Could not save the default payment terms - try again');
      notify.success('Default payment terms saved');
    } catch (err) {
      notify.error(apiErrorMessage(err, 'Could not save the default payment terms - try again'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-6" data-testid="default-payment-terms">
      <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] uppercase tracking-wide mb-1">Default payment terms</h2>
      <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">
        Used for a customer or supplier whose own terms are not set: it dates their new invoices and bills. A contact&apos;s own terms always win.
      </p>
      {loadError && <p className="text-sm text-red-500">{loadError}</p>}
      {!terms && !loadError && <Loader2 className="h-5 w-5 animate-spin text-teal-500" />}
      {terms && (
        <div className="max-w-md space-y-3">
          <PaymentTermsField days={terms.days} type={terms.type} error={error} inputClass={inputClass}
            onChange={(days, type) => setTerms({ days, type })} />
          <button type="button" onClick={() => { void save(); }} disabled={saving || Boolean(error)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving...' : 'Save default terms'}
          </button>
        </div>
      )}
    </div>
  );
}
