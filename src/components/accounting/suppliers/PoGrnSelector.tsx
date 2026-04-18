/**
 * PoGrnSelector — 3-way match: link a supplier bill to a PO and/or GRN.
 * Renders when a supplier is selected on the bill creation form.
 */
'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Loader2, Link2, ChevronDown } from 'lucide-react';

const inp =
  'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 ' +
  'rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 ' +
  'focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl =
  'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';

export interface PoLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
}

interface Po {
  id: string;
  po_number: string;
  order_date: string;
  status: string;
  total: number;
}

interface Grn {
  id: string;
  grn_number: string;
  received_date: string;
  purchase_order_id: string;
  po_number: string;
}

export interface PoGrnSelectorProps {
  supplierId: string;
  selectedPoId: string;
  selectedGrnId: string;
  copyLines: boolean;
  onPoChange: (poId: string) => void;
  onGrnChange: (grnId: string) => void;
  onCopyLinesChange: (copy: boolean) => void;
  onPoLineItems: (items: PoLineItem[]) => void;
}

export function PoGrnSelector({
  supplierId,
  selectedPoId,
  selectedGrnId,
  copyLines,
  onPoChange,
  onGrnChange,
  onCopyLinesChange,
  onPoLineItems,
}: PoGrnSelectorProps) {
  const [pos, setPos] = useState<Po[]>([]);
  const [grns, setGrns] = useState<Grn[]>([]);
  const [loading, setLoading] = useState(false);
  const [copyLoading, setCopyLoading] = useState(false);

  // Fetch POs + all GRNs for supplier when supplier changes
  const fetchPosAndGrns = useCallback(async (sid: string) => {
    setLoading(true);
    try {
      const res = await apiFetch(
        `/api/accounting/purchase-orders/unmatched?supplierId=${encodeURIComponent(sid)}&include=both`
      );
      if (!res.ok) return;
      const json = await res.json();
      const data = json.data || json;
      setPos(data.pos ?? []);
      setGrns(data.grns ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-filter GRNs when a PO is selected
  const fetchGrnsForPo = useCallback(async (sid: string, poId: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ supplierId: sid, purchaseOrderId: poId, include: 'grns' });
      const res = await apiFetch(`/api/accounting/purchase-orders/unmatched?${params.toString()}`);
      if (!res.ok) return;
      const json = await res.json();
      const data = json.data || json;
      setGrns(data.grns ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!supplierId) {
      setPos([]);
      setGrns([]);
      return;
    }
    void fetchPosAndGrns(supplierId);
  }, [supplierId, fetchPosAndGrns]);

  const handlePoChange = (poId: string) => {
    onPoChange(poId);
    onGrnChange(''); // reset GRN when PO changes
    onCopyLinesChange(false);
    if (poId && supplierId) {
      void fetchGrnsForPo(supplierId, poId);
    } else if (supplierId) {
      void fetchPosAndGrns(supplierId);
    }
  };

  const handleCopyLines = async (checked: boolean) => {
    onCopyLinesChange(checked);
    if (!checked || !selectedPoId) return;
    setCopyLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/purchase-orders/${selectedPoId}`);
      if (!res.ok) return;
      const json = await res.json();
      const po = json.data || json;
      const items: PoLineItem[] = (po.items ?? []).map((item: Record<string, unknown>) => ({
        description: String(item.description ?? ''),
        quantity: Number(item.quantity ?? 1),
        unitPrice: Number(item.unit_price ?? 0),
        taxRate: Number(item.tax_rate ?? 15),
      }));
      onPoLineItems(items);
    } finally {
      setCopyLoading(false);
    }
  };

  if (!supplierId) return null;

  const filteredGrns = selectedPoId
    ? grns.filter(g => g.purchase_order_id === selectedPoId)
    : grns;

  return (
    <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800">
      <div className="flex items-center gap-2 mb-3">
        <Link2 className="h-3.5 w-3.5 text-amber-500" />
        <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
          3-Way Match (optional)
        </span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-slate-400" />}
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* PO dropdown */}
        <div>
          <label className={lbl}>Link to Purchase Order</label>
          <div className="relative">
            <select
              value={selectedPoId}
              onChange={e => handlePoChange(e.target.value)}
              className={`${inp} appearance-none pr-8`}
            >
              <option value="">— No PO —</option>
              {pos.map(po => (
                <option key={po.id} value={po.id}>
                  {po.po_number} ({po.status})
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          </div>
          {pos.length === 0 && !loading && (
            <p className="text-[10px] text-slate-400 mt-1">No open POs for this supplier.</p>
          )}
        </div>

        {/* GRN dropdown */}
        <div>
          <label className={lbl}>Link to GRN</label>
          <div className="relative">
            <select
              value={selectedGrnId}
              onChange={e => onGrnChange(e.target.value)}
              className={`${inp} appearance-none pr-8`}
            >
              <option value="">— No GRN —</option>
              {filteredGrns.map(grn => (
                <option key={grn.id} value={grn.id}>
                  {grn.grn_number} — {grn.po_number}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          </div>
          {filteredGrns.length === 0 && !loading && (
            <p className="text-[10px] text-slate-400 mt-1">
              {selectedPoId ? 'No GRNs for selected PO.' : 'No GRNs for this supplier.'}
            </p>
          )}
        </div>
      </div>

      {/* Copy line items toggle — only shown when a PO is selected */}
      {selectedPoId && (
        <label className="inline-flex items-center gap-2 mt-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={copyLines}
            onChange={e => void handleCopyLines(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-300 text-amber-500 focus:ring-amber-500/30"
          />
          <span className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
            Copy line items from PO
            {copyLoading && <Loader2 className="h-3 w-3 animate-spin" />}
          </span>
        </label>
      )}
    </div>
  );
}
