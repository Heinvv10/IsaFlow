/**
 * Asset Detail Page
 * View fixed asset information
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Package, Loader2, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Asset {
  id: string;
  asset_number: string;
  name: string;
  category: string | null;
  purchase_date: string | null;
  purchase_price: number | null;
  current_book_value: number | null;
  useful_life_years: number | null;
  status: string | null;
  created_at: string;
}

const fmtCurrency = (v: number | null | undefined) =>
  v != null
    ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(Number(v))
    : null;

export default function AssetDetailPage() {
  const router = useRouter();
  const { assetId } = router.query;
  const [asset, setAsset] = useState<Asset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!assetId) return;
    loadAsset();
  }, [assetId]);

  const loadAsset = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/accounting/assets');
      const json = await res.json();
      const data = json.data || json;
      if (Array.isArray(data)) {
        const match = data.find((a: Asset) => a.id === assetId);
        setAsset(match || null);
        if (!match) setError('Asset not found');
      } else {
        setAsset(data);
      }
    } catch {
      setError('Failed to load asset');
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

  if (!asset) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh] flex-col">
          <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
          <p className="text-[var(--ff-text-secondary)]">{error || 'Asset not found'}</p>
          <Link href="/accounting/assets" className="mt-4 text-sm text-blue-400 hover:text-blue-300">
            Back to Assets
          </Link>
        </div>
      </AppLayout>
    );
  }

  const isActive = asset.status?.toLowerCase() === 'active';

  const fields: { label: string; value: string | number | null | undefined; highlight?: boolean }[] = [
    { label: 'Asset Number', value: asset.asset_number, highlight: true },
    { label: 'Name', value: asset.name },
    { label: 'Category', value: asset.category },
    { label: 'Purchase Date', value: asset.purchase_date?.split('T')[0] },
    { label: 'Purchase Price', value: fmtCurrency(asset.purchase_price) },
    { label: 'Current Book Value', value: fmtCurrency(asset.current_book_value) },
    { label: 'Useful Life', value: asset.useful_life_years ? `${asset.useful_life_years} years` : null },
  ];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/assets" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Assets
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Package className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{asset.name}</h1>
              {asset.asset_number && (
                <p className="text-sm text-[var(--ff-text-secondary)]">{asset.asset_number}</p>
              )}
            </div>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${isActive ? 'bg-teal-500/20 text-teal-400' : 'bg-gray-500/20 text-gray-400'}`}>
              {asset.status || 'Unknown'}
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
              {isActive
                ? <><CheckCircle2 className="h-5 w-5 text-teal-400" /><span className="text-sm text-teal-400 font-medium">Active Asset</span></>
                : <><XCircle className="h-5 w-5 text-gray-400" /><span className="text-sm text-gray-400 font-medium">{asset.status || 'Inactive'} Asset</span></>
              }
            </div>
            {asset.created_at && (
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-2">
                Created: {asset.created_at.split('T')[0]}
              </p>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
