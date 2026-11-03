/**
 * Purchase Order Detail / Edit Page
 * Route: /accounting/purchase-orders/[poId]
 * Budgets P5-3: a draft or submitted PO is approved with the Approve button (budget check, approved_by / approved_at),
 * never through the status select; lines carry CC1 / CC2 / BU.
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
  Download,
  PackagePlus,
} from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { chartAccountOptions } from '@/lib/chartAccountOptions';
import type { GLAccount as ChartGLAccount } from '@/modules/accounting/types/gl.types';
import { SupplierSelect } from '@/components/accounting/supplier-invoices/SupplierSelect';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import { GatedDateField, useDateGate } from '@/components/forms/GatedDateField';
import { PoLineItemsEditor, type PoEditField, type PoEditLine } from '@/components/accounting/purchase-orders/PoLineItemsEditor';
import { PurchaseOrderApproveButton } from '@/components/accounting/purchase-orders/PurchaseOrderApproveButton';

const fmt = (n: number) => formatMoney(n);

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-400',
  submitted: 'bg-blue-500/20 text-blue-400',
  approved: 'bg-teal-500/20 text-teal-400',
  partially_received: 'bg-amber-500/20 text-amber-400',
  received: 'bg-green-500/20 text-green-400',
  cancelled: 'bg-gray-500/20 text-gray-500',
};

const EDITABLE_STATUSES = ['draft', 'submitted'];
// The Approve action's statuses (ap/purchaseOrderBudget APPROVABLE_PO_STATUSES).
const APPROVABLE_STATUSES = ['draft', 'submitted'];
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
  cc1_id?: string | null;
  cc2_id?: string | null;
  bu_id?: string | null;
  cc1_label?: string | null;
  cc2_label?: string | null;
  bu_label?: string | null;
}

/** "code name" of each dimension the PO's lines carry (labels a stored id the pickers do not offer). */
function storedDimensionLabels(items: PoItem[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of items) {
    for (const [idv, label] of [[i.cc1_id, i.cc1_label], [i.cc2_id, i.cc2_label], [i.bu_id, i.bu_label]] as const) {
      if (idv && label) out[idv] = label;
    }
  }
  return out;
}

const dimensionsText = (i: PoItem): string => [i.cc1_label, i.cc2_label, i.bu_label].filter(Boolean).join(' / ') || '—';

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

interface GlAccount { id: string; name: string; code: string; }

interface EditForm {
  supplier_id: string;
  order_date: string;
  expected_delivery_date: string;
  reference: string;
  notes: string;
  status: string;
  items: PoEditLine[];
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
  const [saveError, setSaveError] = useState(''); const dates = useDateGate();
  const [accounts, setAccounts] = useState<GlAccount[]>([]);
  const [form, setForm] = useState<EditForm | null>(null);

  const loadPO = useCallback(async () => {
    if (!poId) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/purchase-orders/${poId}`, { credentials: 'include' });
      await assertOk(res, 'Could not load the purchase order - try again');
      setPo((await res.json()).data);
    } catch (err) {
      setPo(null);
      setError(apiErrorMessage(err, 'Could not load the purchase order - try again'));
    } finally {
      setLoading(false);
    }
  }, [poId]);

  useEffect(() => { void loadPO(); }, [loadPO]);

  useEffect(() => {
    if (!editing) return;
    apiFetch('/api/accounting/chart-of-accounts', { credentials: 'include' })
      .then(async r => { await assertOk(r, 'Could not load GL accounts - try again'); return r.json(); }).then(j => setAccounts(chartAccountOptions(j.data as ChartGLAccount[] | undefined))).catch(err => setSaveError(apiErrorMessage(err, 'Could not load GL accounts - try again')));
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
        cc1_id: i.cc1_id || '',
        cc2_id: i.cc2_id || '',
        bu_id: i.bu_id || '',
      })),
    });
    setEditing(true);
    setSaveError('');
  };

  const cancelEdit = () => { setEditing(false); setForm(null); setSaveError(''); };

  const addItem = () => setForm(f => f ? {
    ...f,
    items: [...f.items, { description: '', quantity: '1', unit_price: '0', tax_rate: '15', gl_account_id: '', product_id: '', cc1_id: '', cc2_id: '', bu_id: '' }],
  } : f);

  const removeItem = (idx: number) => setForm(f => f ? {
    ...f, items: f.items.filter((_, i) => i !== idx),
  } : f);

  const updateItem = (idx: number, field: PoEditField, value: string) =>
    setForm(f => f ? {
      ...f, items: f.items.map((item, i) => i === idx ? { ...item, [field]: value } : item),
    } : f);

  const handleSave = async () => {
    if (!form || !poId) return; if (dates.blocked) { setSaveError('Fix the date marked in red before saving.'); return; }
    if (!form.order_date) { setSaveError('Enter the order date.'); return; }
    if (!form.supplier_id) { setSaveError('Please select a supplier'); return; }
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
            cc1_id: i.cc1_id || null,
            cc2_id: i.cc2_id || null,
            bu_id: i.bu_id || null,
            sort_order: idx,
          })),
        }),
      });
      await assertOk(res, 'Could not save the purchase order - try again');
      setPo((await res.json()).data);
      setEditing(false);
      setForm(null);
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not save the purchase order - try again'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!po || po.status !== 'draft') return;
    if (!confirm(`Delete PO ${po.po_number}? This cannot be undone.`)) return;
    setDeleting(true);
    setSaveError('');
    try {
      const res = await apiFetch(`/api/accounting/purchase-orders/${poId}`, {
        method: 'DELETE', credentials: 'include',
      });
      await assertOk(res, 'Could not delete the purchase order - try again');
      void router.push('/accounting/purchase-orders');
    } catch (err) {
      setSaveError(apiErrorMessage(err, 'Could not delete the purchase order - try again'));
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
  const canApprove = APPROVABLE_STATUSES.includes(po.status);
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
              {canApprove && !editing && (
                <PurchaseOrderApproveButton poId={po.id} onApproved={loadPO} onError={setSaveError} onReload={loadPO} />
              )}
              {canEdit && !editing && (
                <>
                  <button onClick={startEdit}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium">
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
                    className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium disabled:opacity-50">
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
                  { label: 'Order Date', value: formatDisplayDate(po.order_date) },
                  { label: 'Expected Delivery', value: formatDisplayDate(po.expected_delivery_date) },
                  { label: 'Subtotal', value: fmt(Number(po.subtotal)) },
                  { label: 'VAT', value: fmt(Number(po.tax_amount)) },
                  { label: 'Total', value: fmt(Number(po.total)), highlight: true },
                  { label: 'Created', value: formatDisplayDate(po.created_at) },
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
                        <th className="px-5 py-3">Dimensions</th>
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
                          <td className="px-5 py-3 text-[var(--ff-text-tertiary)] text-xs">{dimensionsText(item)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-[var(--ff-border-light)]">
                        <td colSpan={4} className="px-5 py-3 text-right text-sm text-[var(--ff-text-secondary)]">Total (incl. VAT)</td>
                        <td className="px-5 py-3 text-right font-bold text-teal-400">{fmt(Number(po.total))}</td>
                        <td colSpan={2} />
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
                    <SupplierSelect required value={form.supplier_id}
                      onChange={id => setForm(f => f ? { ...f, supplier_id: id } : f)} />
                  </div>
                  <div>
                    <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Reference</label>
                    <input type="text" name="reference" value={form.reference}
                      onChange={e => setForm(f => f ? { ...f, reference: e.target.value } : f)}
                      className="ff-input w-full" placeholder="Supplier quote ref" />
                  </div>
                  <div>
                    <GatedDateField gate={dates} gateKey="orderDate" label="Order Date" required name="orderDate" value={form.order_date || null}
                      onValue={iso => setForm(f => f ? { ...f, order_date: iso } : f)} />
                  </div>
                  <div>
                    <GatedDateField gate={dates} gateKey="expectedDeliveryDate" label="Expected Delivery" name="expectedDeliveryDate" value={form.expected_delivery_date || null}
                      onValue={iso => setForm(f => f ? { ...f, expected_delivery_date: iso } : f)} />
                  </div>
                  <div>
                    <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Status</label>
                    <select name="status" value={form.status}
                      onChange={e => setForm(f => f ? { ...f, status: e.target.value } : f)}
                      className="ff-select w-full">
                      <option value="draft">Draft</option>
                      <option value="submitted">Submitted</option>
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
              <PoLineItemsEditor items={form.items} accounts={accounts} storedLabels={storedDimensionLabels(po.items || [])}
                onAdd={addItem} onRemove={removeItem} onUpdate={updateItem}>
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
              </PoLineItemsEditor>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
