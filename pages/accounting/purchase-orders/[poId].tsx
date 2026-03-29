/**
 * Purchase Order Detail Page
 * View purchase order information
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, ClipboardList, Loader2, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-400',
  pending: 'bg-amber-500/20 text-amber-400',
  approved: 'bg-blue-500/20 text-blue-400',
  sent: 'bg-indigo-500/20 text-indigo-400',
  received: 'bg-teal-500/20 text-teal-400',
  partially_received: 'bg-purple-500/20 text-purple-400',
  cancelled: 'bg-gray-500/20 text-gray-500',
  closed: 'bg-gray-500/20 text-gray-500',
};

interface PurchaseOrder {
  id: string;
  po_number: string;
  supplier_name: string | null;
  supplier_id: string | null;
  order_date: string | null;
  expected_delivery_date: string | null;
  status: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  notes: string | null;
  reference: string | null;
  created_at: string;
}

export default function PurchaseOrderDetailPage() {
  const router = useRouter();
  const { poId } = router.query;
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!poId) return;
    loadPO();
  }, [poId]);

  const loadPO = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/purchase-orders?id=${poId}`);
      const json = await res.json();
      const data = json.data || json;
      // API may return a single object or an array — find matching record
      if (Array.isArray(data)) {
        const match = data.find((p: PurchaseOrder) => p.id === poId);
        setPo(match || null);
        if (!match) setError('Purchase order not found');
      } else {
        setPo(data);
      }
    } catch {
      setError('Failed to load purchase order');
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

  if (!po) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh] flex-col">
          <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
          <p className="text-[var(--ff-text-secondary)]">{error || 'Purchase order not found'}</p>
          <Link href="/accounting/purchase-orders" className="mt-4 text-sm text-blue-400 hover:text-blue-300">
            Back to Purchase Orders
          </Link>
        </div>
      </AppLayout>
    );
  }

  const fields: { label: string; value: string | number | null | undefined; highlight?: boolean }[] = [
    { label: 'PO Number', value: po.po_number, highlight: true },
    { label: 'Supplier', value: po.supplier_name },
    { label: 'Order Date', value: po.order_date?.split('T')[0] },
    { label: 'Expected Delivery', value: po.expected_delivery_date?.split('T')[0] },
    { label: 'Reference', value: po.reference },
    { label: 'Subtotal', value: fmt(Number(po.subtotal)) },
    { label: 'Tax', value: fmt(Number(po.tax_amount)) },
    { label: 'Total', value: fmt(Number(po.total)), highlight: true },
  ];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/purchase-orders" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Purchase Orders
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <ClipboardList className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{po.po_number}</h1>
              {po.supplier_name && (
                <p className="text-sm text-[var(--ff-text-secondary)]">{po.supplier_name}</p>
              )}
            </div>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${STATUS_COLORS[po.status] || 'bg-gray-500/20 text-gray-400'}`}>
              {po.status.replace(/_/g, ' ')}
            </span>
          </div>
        </div>

        {/* Details */}
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {fields.map((f, i) => (
              <div key={i} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">{f.label}</p>
                <p className={`text-lg font-semibold mt-1 ${f.highlight ? 'text-blue-400' : 'text-[var(--ff-text-primary)]'}`}>
                  {f.value || '—'}
                </p>
              </div>
            ))}
          </div>

          {/* Notes */}
          {po.notes && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-1">Notes</p>
              <p className="text-sm text-[var(--ff-text-secondary)]">{po.notes}</p>
            </div>
          )}

          {/* Created info */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
            <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-1">Created</p>
            <p className="text-sm text-[var(--ff-text-secondary)]">{po.created_at?.split('T')[0] || '—'}</p>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
