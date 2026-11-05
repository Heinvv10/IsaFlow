/**
 * Edit Supplier — the supplier form, prefilled, saved with PUT /api/accounting/suppliers-list.
 * Route: /accounting/suppliers/[supplierId]/edit (the Edit button on the supplier page).
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AlertCircle, Loader2, Truck } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { notify } from '@/utils/toast';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { useDateGate } from '@/hooks/useDateGate';
import { SupplierForm, type SupplierFormData } from '@/components/accounting/SupplierForm';
import { paymentTermsFormError } from '@/components/accounting/paymentTermsForm';
import { ContactEditShell } from '@/components/accounting/contactForm/ContactEditShell';
import { supplierEditBody, supplierToForm } from '@/components/accounting/contactForm/supplierFormMapping';
import { changedBody } from '@/components/accounting/contactForm/formMapping';

export default function EditSupplierPage() {
  const router = useRouter();
  const supplierId = typeof router.query.supplierId === 'string' ? router.query.supplierId : '';
  const [form, setForm] = useState<SupplierFormData | null>(null);
  const [loaded, setLoaded] = useState<SupplierFormData | null>(null); // the form as loaded: an edit sends only what differs
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof SupplierFormData, string>>>({});
  const dates = useDateGate();

  useEffect(() => {
    if (!supplierId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/suppliers-list?id=${encodeURIComponent(supplierId)}`);
        await assertOk(res, 'Could not load the supplier - try again');
        const json = await res.json() as { data?: Record<string, unknown> };
        if (cancelled) return;
        if (json.data) { const f = supplierToForm(json.data); setLoaded(f); setForm(f); } else setLoadError('Supplier not found');
      } catch (err) {
        if (!cancelled) { setForm(null); setLoadError(apiErrorMessage(err, 'Could not load the supplier - try again')); }
      }
    })();
    return () => { cancelled = true; };
  }, [supplierId]);

  async function save() {
    if (!form || !loaded) return;
    const errors: Partial<Record<keyof SupplierFormData, string>> = {};
    if (!form.name.trim()) errors.name = 'Supplier name is required';
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.email = 'Enter a valid email address';
    const termsError = paymentTermsFormError(form.payment_terms, form.payment_terms_type);
    if (termsError) errors.payment_terms = termsError;
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const changes = changedBody(supplierEditBody(loaded), supplierEditBody(form));
    if (Object.keys(changes).length === 0) { notify.info('Nothing was changed'); return; }
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/suppliers-list', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: supplierId, ...changes }),
      });
      await assertOk(res, 'Could not save the supplier - try again');
      notify.success('Supplier saved');
      try { await router.push(`/accounting/suppliers/${supplierId}`); } catch (e) { log.warn('navigation failed', { error: e }, 'suppliers-edit'); }
    } catch (err: unknown) {
      notify.error(apiErrorMessage(err, 'Could not save the supplier - try again'));
    } finally {
      setSaving(false);
    }
  }

  if (!form) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh]">
          {loadError ? (
            <>
              <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
              <p className="text-[var(--ff-text-secondary)]">{loadError}</p>
              <Link href="/accounting/suppliers" className="mt-4 text-sm text-blue-400 hover:text-blue-300">Back to Suppliers</Link>
            </>
          ) : <Loader2 className="h-8 w-8 animate-spin text-blue-600 dark:text-blue-400" />}
        </div>
      </AppLayout>
    );
  }

  return (
    <ContactEditShell
      title={`Edit ${form.name || 'supplier'}`} subtitle="Change the supplier's details" backHref={`/accounting/suppliers/${supplierId}`}
      icon={Truck} iconClass="bg-blue-500/10 text-blue-600 dark:text-blue-400" saving={saving} onSubmit={() => { void save(); }} saveLabel="Save Supplier"
    >
      <SupplierForm form={form} onChange={setForm} fieldErrors={fieldErrors} dates={dates} mode="edit" supplierId={supplierId} />
    </ContactEditShell>
  );
}

