/**
 * Customer Detail Page
 * View customer information
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, User, Loader2, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  contact_person: string | null;
  vat_number: string | null;
  registration_number: string | null;
  payment_terms: number | null;
  credit_limit: number | null;
  is_active: boolean;
  created_at: string;
}

export default function CustomerDetailPage() {
  const router = useRouter();
  const { customerId } = router.query;
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!customerId) return;
    loadCustomer();
  }, [customerId]);

  const loadCustomer = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/customers?id=${customerId}`);
      const json = await res.json();
      const data = json.data || json;
      // API may return a single object or an array — find matching record
      if (Array.isArray(data)) {
        const match = data.find((c: Customer) => c.id === customerId);
        setCustomer(match || null);
        if (!match) setError('Customer not found');
      } else {
        setCustomer(data);
      }
    } catch {
      setError('Failed to load customer');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        </div>
      </AppLayout>
    );
  }

  if (!customer) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh] flex-col">
          <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
          <p className="text-[var(--ff-text-secondary)]">{error || 'Customer not found'}</p>
          <Link href="/accounting/customers" className="mt-4 text-sm text-blue-400 hover:text-blue-300">
            Back to Customers
          </Link>
        </div>
      </AppLayout>
    );
  }

  const fields: { label: string; value: string | number | null | undefined; highlight?: boolean }[] = [
    { label: 'Name', value: customer.name, highlight: true },
    { label: 'Email', value: customer.email },
    { label: 'Phone', value: customer.phone },
    { label: 'Contact Person', value: customer.contact_person },
    { label: 'VAT Number', value: customer.vat_number },
    { label: 'Registration Number', value: customer.registration_number },
    { label: 'Payment Terms', value: customer.payment_terms ? `${customer.payment_terms} days` : null },
    { label: 'Credit Limit', value: customer.credit_limit != null ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(Number(customer.credit_limit)) : null },
  ];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/customers" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Customers
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <User className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{customer.name}</h1>
              {customer.email && (
                <p className="text-sm text-[var(--ff-text-secondary)]">{customer.email}</p>
              )}
            </div>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${customer.is_active ? 'bg-teal-500/20 text-teal-400' : 'bg-gray-500/20 text-gray-400'}`}>
              {customer.is_active ? 'Active' : 'Inactive'}
            </span>
          </div>
        </div>

        {/* Details */}
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {fields.map((f, i) => (
              <div key={i} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">{f.label}</p>
                <p className={`text-lg font-semibold mt-1 ${f.highlight ? 'text-blue-400' : 'text-[var(--ff-text-primary)]'}`}>
                  {f.value || '—'}
                </p>
              </div>
            ))}
          </div>

          {/* Status card */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
            <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-2">Status</p>
            <div className="flex items-center gap-2">
              {customer.is_active
                ? <><CheckCircle2 className="h-5 w-5 text-teal-400" /><span className="text-sm text-teal-400 font-medium">Active Customer</span></>
                : <><XCircle className="h-5 w-5 text-gray-400" /><span className="text-sm text-gray-400 font-medium">Inactive Customer</span></>
              }
            </div>
            {customer.created_at && (
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-2">
                Created: {customer.created_at.split('T')[0]}
              </p>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
