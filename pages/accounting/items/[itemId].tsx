/**
 * Item Detail Page
 * View item information
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Box, Loader2, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Item {
  id: string;
  code: string | null;
  description: string | null;
  type: string | null;
  selling_price: number | null;
  cost_price: number | null;
  quantity_on_hand: number | null;
  is_active: boolean;
  created_at: string;
}

const fmtCurrency = (v: number | null | undefined) =>
  v != null
    ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(Number(v))
    : null;

export default function ItemDetailPage() {
  const router = useRouter();
  const { itemId } = router.query;
  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!itemId) return;
    loadItem();
  }, [itemId]);

  const loadItem = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/accounting/items');
      const json = await res.json();
      const data = json.data || json;
      if (Array.isArray(data)) {
        const match = data.find((it: Item) => it.id === itemId);
        setItem(match || null);
        if (!match) setError('Item not found');
      } else {
        setItem(data);
      }
    } catch {
      setError('Failed to load item');
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

  if (!item) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh] flex-col">
          <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
          <p className="text-[var(--ff-text-secondary)]">{error || 'Item not found'}</p>
          <Link href="/accounting/items" className="mt-4 text-sm text-blue-400 hover:text-blue-300">
            Back to Items
          </Link>
        </div>
      </AppLayout>
    );
  }

  const typeLabel = item.type === 'physical' ? 'Physical' : item.type === 'service' ? 'Service' : item.type;

  const fields: { label: string; value: string | number | null | undefined; highlight?: boolean }[] = [
    { label: 'Code', value: item.code, highlight: true },
    { label: 'Description', value: item.description },
    { label: 'Type', value: typeLabel },
    { label: 'Selling Price', value: fmtCurrency(item.selling_price) },
    { label: 'Cost Price', value: fmtCurrency(item.cost_price) },
    { label: 'Quantity on Hand', value: item.quantity_on_hand != null ? String(item.quantity_on_hand) : null },
  ];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/items" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Items
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Box className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{item.description || item.code || 'Item'}</h1>
              {item.code && (
                <p className="text-sm text-[var(--ff-text-secondary)]">{item.code}</p>
              )}
            </div>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${item.is_active ? 'bg-teal-500/20 text-teal-400' : 'bg-gray-500/20 text-gray-400'}`}>
              {item.is_active ? 'Active' : 'Inactive'}
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
                  {f.value || '\u2014'}
                </p>
              </div>
            ))}
          </div>

          {/* Status card */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
            <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-2">Status</p>
            <div className="flex items-center gap-2">
              {item.is_active
                ? <><CheckCircle2 className="h-5 w-5 text-teal-400" /><span className="text-sm text-teal-400 font-medium">Active Item</span></>
                : <><XCircle className="h-5 w-5 text-gray-400" /><span className="text-sm text-gray-400 font-medium">Inactive Item</span></>
              }
            </div>
            {item.created_at && (
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-2">
                Created: {item.created_at.split('T')[0]}
              </p>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
