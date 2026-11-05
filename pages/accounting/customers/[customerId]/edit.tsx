/**
 * Edit Customer — the customer form, prefilled, saved with PUT /api/accounting/customers.
 * Route: /accounting/customers/[customerId]/edit (the Edit button on the customer page).
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AlertCircle, Loader2, Users } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { notify } from '@/utils/toast';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { useDateGate } from '@/hooks/useDateGate';
import { CustomerForm, type CustomerFormData } from '@/components/accounting/CustomerForm';
import { paymentTermsFormError } from '@/components/accounting/paymentTermsForm';
import { ContactEditShell } from '@/components/accounting/contactForm/ContactEditShell';
import { customerEditBody, customerToForm } from '@/components/accounting/contactForm/customerFormMapping';
import { changedBody } from '@/components/accounting/contactForm/formMapping';

type Category = { id: string; name: string };

/** The company's customer categories, or null when they could not be read (the category is then left as stored). */
async function loadCategories(): Promise<Category[] | null> {
  try {
    const res = await apiFetch('/api/accounting/customer-categories');
    if (!res.ok) {
      log.warn('customer categories not loaded', { status: res.status }, 'customers-edit');
      return null;
    }
    const json = await res.json() as { data?: Category[] };
    return Array.isArray(json.data) ? json.data.map((c) => ({ id: c.id, name: c.name })) : null;
  } catch (err) {
    log.warn('customer categories not loaded', { error: err }, 'customers-edit');
    return null;
  }
}

export default function EditCustomerPage() {
  const router = useRouter();
  const customerId = typeof router.query.customerId === 'string' ? router.query.customerId : '';
  const [form, setForm] = useState<CustomerFormData | null>(null);
  const [loaded, setLoaded] = useState<CustomerFormData | null>(null); // the form as loaded: an edit sends only what differs
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof CustomerFormData, string>>>({});
  const dates = useDateGate();

  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [res, cats] = await Promise.all([apiFetch(`/api/accounting/customers?id=${encodeURIComponent(customerId)}`), loadCategories()]);
        await assertOk(res, 'Could not load the customer - try again');
        const json = await res.json() as { data?: Record<string, unknown> | Record<string, unknown>[] };
        if (cancelled) return;
        // A bare, non-UUID id answers with the list; only a single row is a customer.
        if (json.data && !Array.isArray(json.data)) { const f = customerToForm(json.data); setCategories(cats); setLoaded(f); setForm(f); } else setLoadError('Customer not found');
      } catch (err) {
        if (!cancelled) { setForm(null); setLoadError(apiErrorMessage(err, 'Could not load the customer - try again')); }
      }
    })();
    return () => { cancelled = true; };
  }, [customerId]);

  async function save() {
    if (!form || !loaded) return;
    const errors: Partial<Record<keyof CustomerFormData, string>> = {};
    if (!form.name.trim()) errors.name = 'Customer name is required';
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.email = 'Enter a valid email address';
    if (form.credit_limit && isNaN(Number(form.credit_limit))) errors.credit_limit = 'Must be a number';
    const termsError = paymentTermsFormError(form.payment_terms, form.payment_terms_type);
    if (termsError) errors.payment_terms = termsError;
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const changes = changedBody(customerEditBody(loaded, categories !== null), customerEditBody(form, categories !== null));
    if (Object.keys(changes).length === 0) { notify.info('Nothing was changed'); return; }
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/customers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: customerId, ...changes }),
      });
      await assertOk(res, 'Could not save the customer - try again');
      notify.success('Customer saved');
      try { await router.push(`/accounting/customers/${customerId}`); } catch (e) { log.warn('navigation failed', { error: e }, 'customers-edit'); }
    } catch (err: unknown) {
      notify.error(apiErrorMessage(err, 'Could not save the customer - try again'));
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
              <Link href="/accounting/customers" className="mt-4 text-sm text-blue-400 hover:text-blue-300">Back to Customers</Link>
            </>
          ) : <Loader2 className="h-8 w-8 animate-spin text-blue-600 dark:text-blue-400" />}
        </div>
      </AppLayout>
    );
  }

  return (
    <ContactEditShell
      title={`Edit ${form.name || 'customer'}`} subtitle="Change the customer's details" backHref={`/accounting/customers/${customerId}`}
      icon={Users} iconClass="bg-teal-500/10 text-teal-500" saving={saving} onSubmit={() => { void save(); }} saveLabel="Save Customer"
    >
      <CustomerForm form={form} onChange={setForm} fieldErrors={fieldErrors} dates={dates} categories={categories ?? []} mode="edit" />
    </ContactEditShell>
  );
}
