/**
 * New Customer Form Page
 * Creates a new customer record via POST /api/accounting/customers.
 * Route: /accounting/customers/new
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Users, Loader2, ArrowLeft, Save } from 'lucide-react';
import Link from 'next/link';
import { notify } from '@/utils/toast';
import { CustomerForm, type CustomerFormData, INITIAL_CUSTOMER_FORM } from '@/components/accounting/CustomerForm';
import { apiFetch } from '@/lib/apiFetch';

export default function NewCustomerPage() {
  const router = useRouter();
  const [form, setForm] = useState<CustomerFormData>(INITIAL_CUSTOMER_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof CustomerFormData, string>>>({});

  function validate(): boolean {
    const errors: Partial<Record<keyof CustomerFormData, string>> = {};
    if (!form.name.trim()) errors.name = 'Customer name is required';
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      errors.email = 'Enter a valid email address';
    }
    if (form.payment_terms && isNaN(Number(form.payment_terms))) {
      errors.payment_terms = 'Must be a number';
    }
    if (form.credit_limit && isNaN(Number(form.credit_limit))) {
      errors.credit_limit = 'Must be a number';
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/accounting/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          payment_terms: form.payment_terms ? Number(form.payment_terms) : 30,
          credit_limit: form.credit_limit ? Number(form.credit_limit) : null,
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);

      notify.success('Customer created successfully');
      await router.push('/accounting/customers');
    } catch (err: unknown) {
      notify.error(err instanceof Error ? err.message : 'Failed to create customer');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link
              href="/accounting/customers"
              className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Users className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">New Customer</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Add a new customer account</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-3xl">
          <form onSubmit={handleSubmit} noValidate>
            <CustomerForm
              form={form}
              onChange={setForm}
              fieldErrors={fieldErrors}
            />

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 mt-6">
              <Link
                href="/accounting/customers"
                className="px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] text-sm font-medium transition-colors"
              >
                Cancel
              </Link>
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {isSubmitting ? 'Saving...' : 'Save Customer'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
