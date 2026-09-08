/**
 * New Supplier Form Page
 * Creates a new supplier record via POST /api/accounting/suppliers-list.
 * Route: /accounting/suppliers/new
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Truck, Loader2, ArrowLeft, Save } from 'lucide-react';
import Link from 'next/link';
import { notify } from '@/utils/toast';
import { SupplierForm, type SupplierFormData, INITIAL_SUPPLIER_FORM } from '@/components/accounting/SupplierForm';
import { apiFetch } from '@/lib/apiFetch';

export default function NewSupplierPage() {
  const router = useRouter();
  const [form, setForm] = useState<SupplierFormData>(INITIAL_SUPPLIER_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof SupplierFormData, string>>>({});
  const [saveAndNew, setSaveAndNew] = useState(false);

  function validate(): boolean {
    const errors: Partial<Record<keyof SupplierFormData, string>> = {};
    if (!form.name.trim()) errors.name = 'Supplier name is required';
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      errors.email = 'Enter a valid email address';
    }
    if (form.payment_terms && isNaN(Number(form.payment_terms))) {
      errors.payment_terms = 'Must be a number';
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent, andNew = false) {
    e.preventDefault();
    if (!validate()) return;
    setSaveAndNew(andNew);

    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/accounting/suppliers-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          whatsappNumber: form.whatsapp_number.trim() || null,
          payment_terms: form.payment_terms ? Number(form.payment_terms) : 30,
          bank_name: form.bank_name.trim() || null,
          bank_account_number: form.bank_account_number.trim() || null,
          bank_branch_code: form.bank_branch_code.trim() || null,
          bank_account_type: form.bank_account_type || null,
          opening_balance: form.opening_balance ? Number(form.opening_balance) : 0,
          opening_balance_date: form.opening_balance_date || null,
          auto_allocate_strategy: form.auto_allocate_strategy,
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);

      notify.success('Supplier created successfully');
      if (andNew) {
        setForm(INITIAL_SUPPLIER_FORM);
        setFieldErrors({});
        await router.push('/accounting/suppliers/new');
      } else {
        await router.push(`/accounting/suppliers/${json.data?.id ?? ''}`);
      }
    } catch (err: unknown) {
      notify.error(err instanceof Error ? err.message : 'Failed to create supplier');
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
              href="/accounting/suppliers"
              className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Truck className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">New Supplier</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Add a new supplier account</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-3xl">
          <form onSubmit={(e) => handleSubmit(e, saveAndNew)} noValidate>
            <SupplierForm
              form={form}
              onChange={setForm}
              fieldErrors={fieldErrors}
            />

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 mt-6">
              <Link
                href="/accounting/suppliers"
                className="px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] text-sm font-medium transition-colors"
              >
                Cancel
              </Link>
              <button
                type="submit"
                disabled={isSubmitting}
                onClick={() => setSaveAndNew(false)}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
              >
                {isSubmitting && !saveAndNew ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {isSubmitting && !saveAndNew ? 'Saving...' : 'Save Supplier'}
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                onClick={() => setSaveAndNew(true)}
                className="flex items-center gap-2 px-5 py-2 rounded-lg border border-teal-600 text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-900/20 disabled:opacity-60 disabled:cursor-not-allowed text-sm font-medium transition-colors"
              >
                {isSubmitting && saveAndNew ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {isSubmitting && saveAndNew ? 'Saving...' : 'Save & New'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
