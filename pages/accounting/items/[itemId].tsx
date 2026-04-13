/**
 * Item Detail Page
 * View item information and manage bundle components.
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, Box, Loader2, AlertCircle, CheckCircle2, XCircle, Layers,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { BundleEditor } from '@/components/accounting/items/BundleEditor';
import { RecordNavigation } from '@/components/accounting/RecordNavigation';

interface Item {
  id: string;
  code: string | null;
  description: string | null;
  item_type: string | null;
  selling_price_excl: number | null;
  selling_price_incl: number | null;
  cost_price: number | null;
  current_qty: number | null;
  unit: string | null;
  is_active: boolean;
  is_bundle: boolean;
  created_at: string | Date;
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
  const [isBundle, setIsBundle] = useState(false);
  const [togglingBundle, setTogglingBundle] = useState(false);

  useEffect(() => {
    if (!itemId) return;
    void loadItem();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  const loadItem = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/items?id=${String(itemId)}`);
      const json = await res.json() as { data?: unknown };
      const data = json.data;
      if (data && typeof data === 'object' && 'id' in data) {
        const it = data as Item;
        setItem(it);
        setIsBundle(Boolean(it.is_bundle));
      } else {
        setError('Item not found');
      }
    } catch {
      setError('Failed to load item');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleBundle = async () => {
    if (!item) return;
    setTogglingBundle(true);
    try {
      if (!isBundle) {
        setIsBundle(true);
      } else {
        const res = await apiFetch(
          `/api/accounting/item-bundles?itemId=${item.id}`,
          { method: 'DELETE' }
        );
        if (res.ok) setIsBundle(false);
      }
    } finally {
      setTogglingBundle(false);
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

  const typeLabel =
    item.item_type === 'physical' ? 'Physical'
    : item.item_type === 'service' ? 'Service'
    : item.item_type;

  const createdStr =
    typeof item.created_at === 'string'
      ? item.created_at.split('T')[0]
      : new Date(item.created_at).toISOString().split('T')[0];

  const fields: { label: string; value: string | number | null | undefined; highlight?: boolean }[] = [
    { label: 'Code', value: item.code, highlight: true },
    { label: 'Description', value: item.description },
    { label: 'Type', value: typeLabel },
    { label: 'Unit', value: item.unit },
    { label: 'Selling Price (excl.)', value: fmtCurrency(item.selling_price_excl) },
    { label: 'Selling Price (incl.)', value: fmtCurrency(item.selling_price_incl) },
    { label: 'Cost Price', value: fmtCurrency(item.cost_price) },
    { label: 'Qty on Hand', value: item.current_qty != null ? String(item.current_qty) : null },
  ];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <Link
              href="/accounting/items"
              className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400"
            >
              <ArrowLeft className="h-4 w-4" /> Back to Items
            </Link>
            {typeof itemId === 'string' && (
              <RecordNavigation entity="items" currentId={itemId} basePath="/accounting/items" />
            )}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Box className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                {item.description || item.code || 'Item'}
              </h1>
              {item.code && (
                <p className="text-sm text-[var(--ff-text-secondary)]">{item.code}</p>
              )}
            </div>
            <span
              className={`px-3 py-1 rounded-full text-sm font-medium ${
                item.is_active ? 'bg-teal-500/20 text-teal-400' : 'bg-gray-500/20 text-gray-400'
              }`}
            >
              {item.is_active ? 'Active' : 'Inactive'}
            </span>
            {isBundle && (
              <span className="px-3 py-1 rounded-full text-sm font-medium bg-purple-500/20 text-purple-400 inline-flex items-center gap-1">
                <Layers className="h-3.5 w-3.5" /> Bundle
              </span>
            )}
          </div>
        </div>

        {/* Details */}
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
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
              {item.is_active ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-teal-400" />
                  <span className="text-sm text-teal-400 font-medium">Active Item</span>
                </>
              ) : (
                <>
                  <XCircle className="h-5 w-5 text-gray-400" />
                  <span className="text-sm text-gray-400 font-medium">Inactive Item</span>
                </>
              )}
            </div>
            {createdStr && (
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-2">Created: {createdStr}</p>
            )}
          </div>

          {/* Bundle Components */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-purple-400" />
                <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] uppercase tracking-wide">
                  Bundle Components
                </h2>
              </div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <span className="text-sm text-[var(--ff-text-secondary)]">This is a bundle</span>
                <button
                  onClick={handleToggleBundle}
                  disabled={togglingBundle}
                  className={`relative inline-flex h-5 w-9 rounded-full transition-colors focus:outline-none ${
                    isBundle ? 'bg-purple-600' : 'bg-[var(--ff-border-light)]'
                  } ${togglingBundle ? 'opacity-50 cursor-not-allowed' : ''}`}
                  role="switch"
                  aria-checked={isBundle}
                >
                  <span
                    className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5 ${
                      isBundle ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </label>
            </div>

            {isBundle ? (
              <BundleEditor
                itemId={item.id}
                parentDescription={item.description ?? item.code ?? undefined}
                onSaved={() => { void loadItem(); }}
              />
            ) : (
              <p className="text-sm text-[var(--ff-text-tertiary)]">
                Toggle &quot;This is a bundle&quot; above to define component items that will
                auto-expand when this item is added to an invoice or sales order.
              </p>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
