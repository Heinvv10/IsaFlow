/**
 * Supplier Detail Page
 * View supplier information
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Building2, Loader2, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Supplier {
  id: string;
  name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  contact_person: string | null;
  vat_number: string | null;
  payment_terms: number | null;
  is_active: boolean;
  created_at: string;
}

export default function SupplierDetailPage() {
  const router = useRouter();
  const { supplierId } = router.query;
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!supplierId) return;
    loadSupplier();
  }, [supplierId]);

  const loadSupplier = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/suppliers-list?id=${supplierId}`);
      const json = await res.json();
      const data = json.data || json;
      // API may return a single object or an array — find matching record
      if (Array.isArray(data)) {
        const match = data.find((s: Supplier) => s.id === supplierId);
        setSupplier(match || null);
        if (!match) setError('Supplier not found');
      } else {
        setSupplier(data);
      }
    } catch {
      setError('Failed to load supplier');
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

  if (!supplier) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh] flex-col">
          <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
          <p className="text-[var(--ff-text-secondary)]">{error || 'Supplier not found'}</p>
          <Link href="/accounting/suppliers" className="mt-4 text-sm text-blue-400 hover:text-blue-300">
            Back to Suppliers
          </Link>
        </div>
      </AppLayout>
    );
  }

  const fields: { label: string; value: string | number | null | undefined; highlight?: boolean }[] = [
    { label: 'Name', value: supplier.name, highlight: true },
    { label: 'Company Name', value: supplier.company_name },
    { label: 'Email', value: supplier.email },
    { label: 'Phone', value: supplier.phone },
    { label: 'Contact Person', value: supplier.contact_person },
    { label: 'VAT Number', value: supplier.vat_number },
    { label: 'Payment Terms', value: supplier.payment_terms ? `${supplier.payment_terms} days` : null },
  ];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/suppliers" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Suppliers
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Building2 className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{supplier.name}</h1>
              {supplier.company_name && (
                <p className="text-sm text-[var(--ff-text-secondary)]">{supplier.company_name}</p>
              )}
            </div>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${supplier.is_active ? 'bg-teal-500/20 text-teal-400' : 'bg-gray-500/20 text-gray-400'}`}>
              {supplier.is_active ? 'Active' : 'Inactive'}
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
              {supplier.is_active
                ? <><CheckCircle2 className="h-5 w-5 text-teal-400" /><span className="text-sm text-teal-400 font-medium">Active Supplier</span></>
                : <><XCircle className="h-5 w-5 text-gray-400" /><span className="text-sm text-gray-400 font-medium">Inactive Supplier</span></>
              }
            </div>
            {supplier.created_at && (
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-2">
                Created: {supplier.created_at.split('T')[0]}
              </p>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
