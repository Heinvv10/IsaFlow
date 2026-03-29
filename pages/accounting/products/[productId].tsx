/**
 * Product Detail Page
 * View product information
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, ShoppingBag, Loader2, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Product {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  category_name: string | null;
  selling_price: number | null;
  cost_price: number | null;
  qty_on_hand: number | null;
  is_active: boolean;
  created_at: string;
}

const fmtCurrency = (v: number | null | undefined) =>
  v != null
    ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(Number(v))
    : null;

export default function ProductDetailPage() {
  const router = useRouter();
  const { productId } = router.query;
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!productId) return;
    loadProduct();
  }, [productId]);

  const loadProduct = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/accounting/products');
      const json = await res.json();
      const data = json.data || json;
      if (Array.isArray(data)) {
        const match = data.find((p: Product) => p.id === productId);
        setProduct(match || null);
        if (!match) setError('Product not found');
      } else {
        setProduct(data);
      }
    } catch {
      setError('Failed to load product');
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

  if (!product) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh] flex-col">
          <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
          <p className="text-[var(--ff-text-secondary)]">{error || 'Product not found'}</p>
          <Link href="/accounting/products" className="mt-4 text-sm text-blue-400 hover:text-blue-300">
            Back to Products
          </Link>
        </div>
      </AppLayout>
    );
  }

  const fields: { label: string; value: string | number | null | undefined; highlight?: boolean }[] = [
    { label: 'SKU', value: product.sku, highlight: true },
    { label: 'Name', value: product.name },
    { label: 'Description', value: product.description },
    { label: 'Category', value: product.category_name },
    { label: 'Selling Price', value: fmtCurrency(product.selling_price) },
    { label: 'Cost Price', value: fmtCurrency(product.cost_price) },
    { label: 'Qty on Hand', value: product.qty_on_hand != null ? String(product.qty_on_hand) : null },
  ];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/products" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Products
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <ShoppingBag className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{product.name}</h1>
              {product.sku && (
                <p className="text-sm text-[var(--ff-text-secondary)]">{product.sku}</p>
              )}
            </div>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${product.is_active ? 'bg-teal-500/20 text-teal-400' : 'bg-gray-500/20 text-gray-400'}`}>
              {product.is_active ? 'Active' : 'Inactive'}
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
              {product.is_active
                ? <><CheckCircle2 className="h-5 w-5 text-teal-400" /><span className="text-sm text-teal-400 font-medium">Active Product</span></>
                : <><XCircle className="h-5 w-5 text-gray-400" /><span className="text-sm text-gray-400 font-medium">Inactive Product</span></>
              }
            </div>
            {product.created_at && (
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-2">
                Created: {product.created_at.split('T')[0]}
              </p>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
