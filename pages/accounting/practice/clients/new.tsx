/**
 * New Practice Client Page
 * Creates a new practice client via POST /api/accounting/practice/clients.
 * Route: /accounting/practice/clients/new
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Users, Loader2, ArrowLeft, Save, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';

type BillingModel = 'hourly' | 'fixed' | 'retainer';
type ClientStatus = 'prospect' | 'onboarding' | 'active' | 'inactive';

interface FormState {
  legalName: string;
  tradingName: string;
  registrationNo: string;
  taxNo: string;
  billingModel: BillingModel;
  status: ClientStatus;
}

const INITIAL_FORM: FormState = {
  legalName: '',
  tradingName: '',
  registrationNo: '',
  taxNo: '',
  billingModel: 'hourly',
  status: 'prospect',
};

export default function NewPracticeClientPage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  function validate(): boolean {
    const errors: Partial<Record<keyof FormState, string>> = {};
    if (!form.legalName.trim()) errors.legalName = 'Legal name is required';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function handleChange(field: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (fieldErrors[field]) {
      setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setIsSubmitting(true);
    setError('');
    try {
      const body = {
        legalName: form.legalName.trim(),
        tradingName: form.tradingName.trim() || undefined,
        registrationNo: form.registrationNo.trim() || undefined,
        taxNo: form.taxNo.trim() || undefined,
        billingModel: form.billingModel,
        status: form.status,
      };
      const res = await apiFetch('/api/accounting/practice/clients', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      await router.push('/accounting/practice/clients');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create client');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-4">
            <Link
              href="/accounting/practice/clients"
              className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Users className="h-5 w-5 text-teal-400" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">New Client</h1>
                <p className="text-xs text-[var(--ff-text-tertiary)]">Add a practice client</p>
              </div>
            </div>
          </div>
        </div>

        {/* Form */}
        <div className="px-6 py-8 max-w-2xl">
          {error && (
            <div className="flex items-center gap-2 p-3 mb-6 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
            {/* Legal Name */}
            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1.5">
                Legal Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={form.legalName}
                onChange={(e) => handleChange('legalName', e.target.value)}
                placeholder="e.g. Acme (Pty) Ltd"
                className={`w-full py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500 ${
                  fieldErrors.legalName ? 'border-red-500' : 'border-[var(--ff-border-primary)]'
                }`}
              />
              {fieldErrors.legalName && (
                <p className="mt-1 text-xs text-red-400">{fieldErrors.legalName}</p>
              )}
            </div>

            {/* Trading Name */}
            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1.5">
                Trading Name
              </label>
              <input
                type="text"
                value={form.tradingName}
                onChange={(e) => handleChange('tradingName', e.target.value)}
                placeholder="Optional trading name"
                className="w-full py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>

            {/* Reg No + Tax No */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1.5">
                  Registration No
                </label>
                <input
                  type="text"
                  value={form.registrationNo}
                  onChange={(e) => handleChange('registrationNo', e.target.value)}
                  placeholder="e.g. 2023/123456/07"
                  className="w-full py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1.5">
                  Tax No
                </label>
                <input
                  type="text"
                  value={form.taxNo}
                  onChange={(e) => handleChange('taxNo', e.target.value)}
                  placeholder="e.g. 9876543210"
                  className="w-full py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
                />
              </div>
            </div>

            {/* Billing Model + Status */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1.5">
                  Billing Model
                </label>
                <select
                  value={form.billingModel}
                  onChange={(e) => handleChange('billingModel', e.target.value)}
                  className="w-full py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
                >
                  <option value="hourly">Hourly</option>
                  <option value="fixed">Fixed</option>
                  <option value="retainer">Retainer</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1.5">
                  Status
                </label>
                <select
                  value={form.status}
                  onChange={(e) => handleChange('status', e.target.value)}
                  className="w-full py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
                >
                  <option value="prospect">Prospect</option>
                  <option value="onboarding">Onboarding</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {isSubmitting ? 'Saving…' : 'Save Client'}
              </button>
              <Link
                href="/accounting/practice/clients"
                className="px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] text-sm font-medium transition-colors"
              >
                Cancel
              </Link>
            </div>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
