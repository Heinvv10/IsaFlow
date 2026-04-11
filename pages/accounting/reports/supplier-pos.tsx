/** Supplier POs by Supplier Report — Sage Parity */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ShoppingCart, Loader2, Download, ChevronDown, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface SupplierPoRow {
  id: string;
  orderNumber: string;
  orderDate: string;
  deliveryDate: string | null;
  reference: string | null;
  status: string;
  totalAmount: number;
  taxAmount: number;
  subtotal: number;
}

interface SupplierPoGroup {
  supplierId: string;
  supplierName: string;
  poCount: number;
  totalValue: number;
  pos: SupplierPoRow[];
}

interface SupplierPosReportResponse {
  suppliers: SupplierPoGroup[];
  grandTotal: number;
  grandPoCount: number;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'approved', label: 'Approved' },
  { value: 'received', label: 'Received' },
  { value: 'cancelled', label: 'Cancelled' },
];

const STATUS_COLOURS: Record<string, string> = {
  draft: 'text-gray-400 bg-gray-400/10',
  sent: 'text-blue-400 bg-blue-400/10',
  approved: 'text-teal-400 bg-teal-400/10',
  received: 'text-green-400 bg-green-400/10',
  cancelled: 'text-red-400 bg-red-400/10',
};

function statusBadge(status: string) {
  const cls = STATUS_COLOURS[status] ?? 'text-gray-400 bg-gray-400/10';
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium capitalize ${cls}`}>
      {status}
    </span>
  );
}

function buildCsv(suppliers: SupplierPoGroup[]): string {
  const rows: string[] = [
    ['Supplier', 'PO Number', 'Order Date', 'Delivery Date', 'Reference', 'Status', 'Subtotal', 'Tax', 'Total'].join(','),
  ];
  for (const group of suppliers) {
    for (const po of group.pos) {
      rows.push([
        `"${group.supplierName.replace(/"/g, '""')}"`,
        `"${po.orderNumber}"`,
        po.orderDate,
        po.deliveryDate ?? '',
        po.reference ? `"${po.reference.replace(/"/g, '""')}"` : '',
        po.status,
        po.subtotal.toFixed(2),
        po.taxAmount.toFixed(2),
        po.totalAmount.toFixed(2),
      ].join(','));
    }
    rows.push([
      `"${group.supplierName.replace(/"/g, '""')} — TOTAL"`,
      '', '', '', '', '',
      '',
      '',
      group.totalValue.toFixed(2),
    ].join(','));
  }
  return rows.join('\n');
}

function downloadCsv(suppliers: SupplierPoGroup[]) {
  const csv = buildCsv(suppliers);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `supplier-pos-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function SupplierGroup({ group }: { group: SupplierPoGroup }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="border border-[var(--ff-border-light)] rounded-lg overflow-hidden mb-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[var(--ff-bg-secondary)] hover:bg-[var(--ff-bg-tertiary)] transition-colors"
      >
        <div className="flex items-center gap-2">
          {open
            ? <ChevronDown className="h-4 w-4 text-[var(--ff-text-secondary)]" />
            : <ChevronRight className="h-4 w-4 text-[var(--ff-text-secondary)]" />}
          <span className="font-semibold text-[var(--ff-text-primary)]">{group.supplierName}</span>
          <span className="text-xs text-[var(--ff-text-secondary)] ml-1">
            {group.poCount} {group.poCount === 1 ? 'PO' : 'POs'}
          </span>
        </div>
        <span className="font-mono font-bold text-[var(--ff-text-primary)]">
          {fmt(group.totalValue)}
        </span>
      </button>

      {open && (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--ff-bg-tertiary)] border-t border-b border-[var(--ff-border-light)]">
              <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">PO Number</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Order Date</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Delivery Date</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Reference</th>
              <th className="px-4 py-2 text-center text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Status</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Subtotal</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Tax</th>
              <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ff-border-light)]">
            {group.pos.map(po => (
              <tr key={po.id} className="hover:bg-[var(--ff-bg-tertiary)] bg-[var(--ff-bg-primary)]">
                <td className="px-4 py-2 text-[var(--ff-text-primary)] font-mono text-xs">{po.orderNumber}</td>
                <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{po.orderDate}</td>
                <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{po.deliveryDate ?? '—'}</td>
                <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{po.reference ?? '—'}</td>
                <td className="px-4 py-2 text-center">{statusBadge(po.status)}</td>
                <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-secondary)]">{fmt(po.subtotal)}</td>
                <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-secondary)]">{fmt(po.taxAmount)}</td>
                <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-primary)] font-semibold">{fmt(po.totalAmount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
              <td colSpan={7} className="px-4 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                Supplier Total
              </td>
              <td className="px-4 py-2 text-right font-mono font-bold text-[var(--ff-text-primary)]">
                {fmt(group.totalValue)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

export default function SupplierPosReport() {
  const [data, setData] = useState<SupplierPosReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0]!;
  const todayStr = today.toISOString().split('T')[0]!;

  const [status, setStatus] = useState('');
  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(todayStr);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      const res = await apiFetch(`/api/accounting/reports-supplier-pos?${params}`, {
        credentials: 'include',
      });
      const json = await res.json() as { data: SupplierPosReportResponse };
      setData(json.data ?? null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [status, dateFrom, dateTo]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10">
                <ShoppingCart className="h-6 w-6 text-orange-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Supplier POs by Supplier</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Purchase orders grouped and totalled per supplier</p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={status}
                onChange={e => setStatus(e.target.value)}
                className="ff-input text-sm"
              >
                {STATUS_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="ff-input text-sm"
              />
              <span className="text-[var(--ff-text-tertiary)] text-sm">to</span>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="ff-input text-sm"
              />
              <button
                onClick={() => data && downloadCsv(data.suppliers)}
                disabled={!data || data.suppliers.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                <Download className="h-4 w-4" /> CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--ff-text-tertiary)]" />
            </div>
          ) : !data || data.suppliers.length === 0 ? (
            <div className="text-center py-16 text-[var(--ff-text-tertiary)]">
              No purchase orders found for the selected filters.
            </div>
          ) : (
            <>
              {/* Supplier groups */}
              {data.suppliers.map(group => (
                <SupplierGroup key={group.supplierId} group={group} />
              ))}

              {/* Grand total summary */}
              <div className="mt-6 border border-[var(--ff-border-medium)] rounded-lg bg-[var(--ff-bg-secondary)] p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm text-[var(--ff-text-secondary)]">Grand Total</div>
                    <div className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">
                      {data.grandPoCount} {data.grandPoCount === 1 ? 'Purchase Order' : 'Purchase Orders'} across{' '}
                      {data.suppliers.length} {data.suppliers.length === 1 ? 'supplier' : 'suppliers'}
                    </div>
                  </div>
                  <div className="text-2xl font-bold font-mono text-[var(--ff-text-primary)]">
                    {fmt(data.grandTotal)}
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
