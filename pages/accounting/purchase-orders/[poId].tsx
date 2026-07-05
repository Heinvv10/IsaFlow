/**
 * Purchase Order Detail / Edit Page
 * Route: /accounting/purchase-orders/[poId]
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft,
  ShoppingCart,
  Loader2,
  AlertCircle,
  Edit2,
  Save,
  X,
  Trash2,
  Plus,
  Download,
  PackagePlus,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-400',
  submitted: 'bg-blue-500/20 text-blue-400',
  approved: 'bg-teal-500/20 text-teal-400',
  partially_received: 'bg-amber-500/20 text-amber-400',
  received: 'bg-green-500/20 text-green-400',
  cancelled: 'bg-gray-500/20 text-gray-500',
};

const EDITABLE_STATUSES = ['draft', 'submitted'];
const GRN_ALLOWED_STATUSES = ['submitted', 'approved', 'partially_received'];

interface PoItem {
  id?: string;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  line_total?: number;
  tax_amount?: number;
  gl_account_id?: string | null;
  account_name?: string | null;
  product_id?: string | null;
}

interface PurchaseOrder {
  id: string;
  po_number: string;
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_email: string | null;
  supplier_phone: string | null;
  order_date: string | null;
  expected_delivery_date: string | null;
  status: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  notes: string | null;
  reference: string | null;
  created_at: string;
  items: PoItem[];
}

interface Supplier { id: string; name: string; }
interface GlAccount { id: string; name: string; code: string; }

interface EditForm {
  supplier_id: string;
  order_date: string;
  expected_delivery_date: string;
  reference: string;
  notes: string;
  status: string;
  items: Array<{
    id?: string;
    description: string;
    quantity: string;
    unit_price: string;
    tax_rate: string;
    gl_account_id: string;
    product_id: string;
  }>;
}

export default function PurchaseOrderDetailPage() {
  const router = useRouter();
  const { poId } = router.query;

  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [accounts, setAccounts] = useState<GlAccount[]>([]);
  const [form, setForm] = useState<EditForm | null>(null);

  const loadPO = useCallback(async () => {
    if (!poId) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/purchase-orders/${poId}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Not found');
      setPo(json.data);
    } catch {
      setError('Failed to load purchase order');
    } finally {
      setLoading(false);
    }
  }, [poId]);

  useEffect(() => { void loadPO(); }, [loadPO]);

  useEffect(() => {
    if (!editing) return;
    apiFetch('/api/accounting/suppliers-list', { credentials: 'include' })
      .then(r => r.json()).then(j => {
        const d = j.data ?? j;
        setSuppliers(Array.isArray(d) ? d : (d.suppliers ?? []));
      }).catch(() => {});
    apiFetch('/api/accounting/chart-of-accounts', { credentials: 'include' })
      .then(r => r.json()).then(j => setAccounts((j.data || []).filter((a: GlAccount & { is_active?: boolean }) => a.is_active !== false))).catch(() => {});
  }, [editing]);

  const startEdit = () => {
    if (!po) return;
    setForm({
      supplier_id: po.supplier_id || '',
      order_date: po.order_date?.split('T')[0] || '',
      expected_delivery_date: po.expected_delivery_date?.split('T')[0] || '',
      reference: po.reference || '',
      notes: po.notes || '',
      status: po.status,
      items: (po.items || []).map(i => ({
        id: i.id,
        description: i.description,
        quantity: String(i.quantity),
        unit_price: String(i.unit_price),
        tax_rate: String(i.tax_rate ?? 15),
        gl_account_id: i.gl_account_id || '',
        product_id: i.product_id || '',
      })),
    });
    setEditing(true);
    setSaveError('');
  };

  const cancelEdit = () => { setEditing(false); setForm(null); setSaveError(''); };

  const addItem = () => setForm(f => f ? {
    ...f,
    items: [...f.items, { description: '', quantity: '1', unit_price: '0', tax_rate: '15', gl_account_id: '', product_id: '' }],
  } : f);

  const removeItem = (idx: number) => setForm(f => f ? {
    ...f, items: f.items.filter((_, i) => i !== idx),
  } : f);

  const updateItem = (idx: number, field: string, value: string) =>
    setForm(f => f ? {
      ...f, items: f.items.map((item, i) => i === idx ? { ...item, [field]: value } : item),
    } : f);

  const handleSave = async () => {
    if (!form || !poId) return;
    setSaving(true);
    setSaveError('');
    try {
      const res = await apiFetch(`/api/accounting/purchase-orders/${poId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          expected_delivery_date: form.expected_delivery_date || null,
          reference: form.reference || null,
          notes: form.notes || null,
          items: form.items.map((i, idx) => ({
            id: i.id,
            description: i.description,
            quantity: Number(i.quantity),
            unit_price: Number(i.unit_price),
            tax_rate: Number(i.tax_rate),
            gl_account_id: i.gl_account_id || null,
            product_id: i.product_id || null,
            sort_order: idx,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Save failed');
      setPo(json.data);
      setEditing(false);
      setForm(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!po || po.status !== 'draft') return;
    if (!confirm(`Delete PO ${po.po_number}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/accounting/purchase-orders/${poId}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) throw new Error('Delete failed');
      void router.push('/accounting/purchase-orders');
    } catch {
      setDeleting(false);
    }
  };

  // ── Computed totals during edit ──────────────────────────────────────────────
  const editSubtotal = form?.items.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unit_price || 0), 0) ?? 0;
  const editTax = form?.items.reduce((s, i) => {
    const lt = Number(i.quantity || 0) * Number(i.unit_price || 0);
    return s + lt * Number(i.tax_rate || 0) / 100;
  }, 0) ?? 0;

  // ── Loading / error states ───────────────────────────────────────────────────
  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
        </div>
      </AppLayout>
    );
  }

  if (!po) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh] flex-col gap-3">
          <AlertCircle className="h-8 w-8 text-red-400" />
          <p className="text-[var(--ff-text-secondary)]">{error || 'Purchase order not found'}</p>
          <Link href="/accounting/purchase-orders" className="text-sm text-teal-400 hover:text-teal-300">
            Back to Purchase Orders
          </Link>
        </div>
      </AppLayout>
    );
  }

  const canEdit = EDITABLE_STATUSES.includes(po.status);
  const canCreateGrn = GRN_ALLOWED_STATUSES.includes(po.status);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/purchase-orders"
            className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-teal-400 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Purchase Orders
          </Link>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10">
                <ShoppingCart className="h-6 w-6 text-orange-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{po.po_number}</h1>
                {po.supplier_name && (
                  <p className="text-sm text-[var(--ff-text-secondary)]">{po.supplier_name}</p>
                )}
              </div>
              <span className={`px-3 py-1 rounded-full text-sm font-medium capitalize ${STATUS_COLORS[po.status] || 'bg-gray-500/20 text-gray-400'}`}>
                {po.status.replace(/_/g, ' ')}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={`/api/accounting/purchase-order-pdf?poId=${po.id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 px-3 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-sm font-medium"
              >
                <Download className="h-4 w-4" />PDF
              </a>
              {canCreateGrn && !editing && (
                <Link
                  href={`/accounting/goods-received/new?poId=${po.id}`}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-medium"
                >
                  <PackagePlus className="h-4 w-4" /> Create GRN
                </Link>
              )}
              {canEdit && !editing && (
                <>
                  <button onClick={startEdit}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium">
                    <Edit2 className="h-4 w-4" /> Edit
                  </button>
                  {po.status === 'draft' && (
                    <button onClick={handleDelete} disabled={deleting}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg text-sm font-medium disabled:opacity-50">
                      <Trash2 className="h-4 w-4" /> {deleting ? 'Deleting...' : 'Delete'}
                    </button>
                  )}
                </>
              )}
              {editing && (
                <>
                  <button onClick={cancelEdit} className="inline-flex items-center gap-2 px-4 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg text-sm">
                    <X className="h-4 w-4" /> Cancel
                  </button>
                  <button onClick={handleSave} disabled={saving}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50">
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 max-w-5xl">
          {saveError && (
            <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{saveError}</div>
          )}

          {/* View mode */}
          {!editing && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: 'PO Number', value: po.po_number, highlight: true },
                  { label: 'Reference', value: po.reference || '—' },
                  { label: 'Order Date', value: po.order_date?.split('T')[0] || '—' },
                  { label: 'Expected Delivery', value: po.expected_delivery_date?.split('T')[0] || '—' },
                  { label: 'Subtotal', value: fmt(Number(po.subtotal)) },
                  { label: 'VAT', value: fmt(Number(po.tax_amount)) },
                  { label: 'Total', value: fmt(Number(po.total)), highlight: true },
                  { label: 'Created', value: po.created_at?.split('T')[0] || '—' },
                ].map((f, i) => (
                  <div key={i} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                    <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-1">{f.label}</p>
                    <p className={`text-sm font-semibold ${f.highlight ? 'text-teal-400' : 'text-[var(--ff-text-primary)]'}`}>{f.value}</p>
                  </div>
                ))}
              </div>

              {po.notes && (
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                  <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-1">Notes</p>
                  <p className="text-sm text-[var(--ff-text-secondary)]">{po.notes}</p>
                </div>
              )}

              {/* Line Items */}
              {po.items && po.items.length > 0 && (
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                  <div className="px-5 py-3 border-b border-[var(--ff-border-light)]">
                    <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Line Items</h3>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b border-[var(--ff-border-light)] text-[var(--ff-text-secondary)]">
                        <th className="px-5 py-3">Description</th>
                        <th className="px-5 py-3 text-right">Qty</th>
                        <th className="px-5 py-3 text-right">Unit Price</th>
                        <th className="px-5 py-3 text-right">VAT %</th>
                        <th className="px-5 py-3 text-right">Line Total</th>
                        <th className="px-5 py-3">Account</th>
                      </tr>
                    </thead>
                    <tbody>
                      {po.items.map((item, i) => (
                        <tr key={i} className="border-b border-[var(--ff-border-light)]">
                          <td className="px-5 py-3 text-[var(--ff-text-primary)]">{item.description}</td>
                          <td className="px-5 py-3 text-right text-[var(--ff-text-secondary)]">{item.quantity}</td>
                          <td className="px-5 py-3 text-right text-[var(--ff-text-secondary)]">{fmt(Number(item.unit_price))}</td>
                          <td className="px-5 py-3 text-right text-[var(--ff-text-secondary)]">{item.tax_rate}%</td>
                          <td className="px-5 py-3 text-right text-[var(--ff-text-primary)]">{fmt(Number(item.line_total ?? Number(item.quantity) * Number(item.unit_price)))}</td>
                          <td className="px-5 py-3 text-[var(--ff-text-tertiary)] text-xs">{item.account_name || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-[var(--ff-border-light)]">
                        <td colSpan={4} className="px-5 py-3 text-right text-sm text-[var(--ff-text-secondary)]">Total (incl. VAT)</td>
                        <td className="px-5 py-3 text-right font-bold text-teal-400">{fmt(Number(po.total))}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </>
          )}

          {/* Edit mode */}
          {editing && form && (
            <>
              {/* Order Details */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
                <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Order Details</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Supplier *</label>
                    <select name="supplierId" required value={form.supplier_id}
                      onChange={e => setForm(f => f ? { ...f, supplier_id: e.target.value } : f)}
                      className="ff-select w-full">
                      <option value="">Select supplier...</option>
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Reference</label>
                    <input type="text" name="reference" value={form.reference}
                      onChange={e => setForm(f => f ? { ...f, reference: e.target.value } : f)}
                      className="ff-input w-full" placeholder="Supplier quote ref" />
                  </div>
                  <div>
                    <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Order Date *</label>
                    <input type="date" name="orderDate" required value={form.order_date}
                      onChange={e => setForm(f => f ? { ...f, order_date: e.target.value } : f)}
                      className="ff-input w-full" />
                  </div>
                  <div>
                    <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Expected Delivery</label>
                    <input type="date" name="expectedDeliveryDate" value={form.expected_delivery_date}
                      onChange={e => setForm(f => f ? { ...f, expected_delivery_date: e.target.value } : f)}
                      className="ff-input w-full" />
                  </div>
                  <div>
                    <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Status</label>
                    <select name="status" value={form.status}
                      onChange={e => setForm(f => f ? { ...f, status: e.target.value } : f)}
                      className="ff-select w-full">
                      <option value="draft">Draft</option>
                      <option value="submitted">Submitted</option>
                      <option value="approved">Approved</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Notes</label>
                    <input type="text" name="notes" value={form.notes}
                      onChange={e => setForm(f => f ? { ...f, notes: e.target.value } : f)}
                      className="ff-input w-full" placeholder="Internal notes" />
                  </div>
                </div>
              </div>

              {/* Line Items */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Line Items</h2>
                  <button type="button" onClick={addItem}
                    className="inline-flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300">
                    <Plus className="h-3 w-3" /> Add Item
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[var(--ff-text-secondary)] border-b border-[var(--ff-border-light)]">
                        <th className="pb-2 pr-2">Description</th>
                        <th className="pb-2 pr-2 w-24 text-right">Qty</th>
                        <th className="pb-2 pr-2 w-32 text-right">Unit Price</th>
                        <th className="pb-2 pr-2 w-20 text-right">VAT %</th>
                        <th className="pb-2 pr-2 w-48">Account</th>
                        <th className="pb-2 w-28 text-right">Total</th>
                        <th className="pb-2 w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {form.items.map((item, idx) => {
                        const lineTotal = Number(item.quantity || 0) * Number(item.unit_price || 0);
                        return (
                          <tr key={idx} className="border-b border-[var(--ff-border-light)]">
                            <td className="py-2 pr-2">
                              <input type="text" required name="description" value={item.description}
                                onChange={e => updateItem(idx, 'description', e.target.value)}
                                className="ff-input w-full text-sm" placeholder="Item description" />
                            </td>
                            <td className="py-2 pr-2">
                              <input type="number" required name="quantity" min="0.01" step="0.01" value={item.quantity}
                                onChange={e => updateItem(idx, 'quantity', e.target.value)}
                                className="ff-input w-full text-sm text-right" />
                            </td>
                            <td className="py-2 pr-2">
                              <input type="number" required name="unitPrice" min="0" step="0.01" value={item.unit_price}
                                onChange={e => updateItem(idx, 'unit_price', e.target.value)}
                                className="ff-input w-full text-sm text-right" />
                            </td>
                            <td className="py-2 pr-2">
                              <input type="number" name="taxRate" min="0" step="0.01" value={item.tax_rate}
                                onChange={e => updateItem(idx, 'tax_rate', e.target.value)}
                                className="ff-input w-full text-sm text-right" />
                            </td>
                            <td className="py-2 pr-2">
                              <select name="glAccountId" value={item.gl_account_id}
                                onChange={e => updateItem(idx, 'gl_account_id', e.target.value)}
                                className="ff-select w-full text-sm">
                                <option value="">No account</option>
                                {accounts.map(a => (
                                  <option key={a.id} value={a.id}>{a.code} – {a.name}</option>
                                ))}
                              </select>
                            </td>
                            <td className="py-2 pr-2 text-right text-[var(--ff-text-primary)]">
                              {fmt(lineTotal)}
                            </td>
                            <td className="py-2">
                              {form.items.length > 1 && (
                                <button type="button" onClick={() => removeItem(idx)}
                                  className="text-red-400 hover:text-red-300">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex justify-end">
                  <div className="text-sm space-y-1 w-48">
                    <div className="flex justify-between">
                      <span className="text-[var(--ff-text-secondary)]">Subtotal:</span>
                      <span className="text-[var(--ff-text-primary)]">{fmt(editSubtotal)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--ff-text-secondary)]">VAT:</span>
                      <span className="text-[var(--ff-text-primary)]">{fmt(editTax)}</span>
                    </div>
                    <div className="flex justify-between font-bold border-t border-[var(--ff-border-light)] pt-1">
                      <span className="text-[var(--ff-text-primary)]">Total:</span>
                      <span className="text-teal-400">{fmt(editSubtotal + editTax)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
