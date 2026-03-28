/**
 * Item Movement Report
 * Sage Parity: Items > Reports > Item Movement
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ArrowLeftRight, Loader2, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Row { date: string; type: string; reference: string; itemCode: string; itemName: string; qtyIn: number; qtyOut: number; balance: number; }

export default function ItemMovementReport() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const today = new Date();
  const [from, setFrom] = useState(new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0]);
  const [to, setTo] = useState(today.toISOString().split('T')[0]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiFetch(`/api/accounting/reports/item-movement?from=${from}&to=${to}`, { credentials: 'include' });
    const json = await res.json();
    setRows(json.data || []);
    setLoading(false);
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-cyan-500/10"><ArrowLeftRight className="h-6 w-6 text-cyan-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Item Movement</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Stock in/out log with running balance</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="ff-input text-sm" />
              <span className="text-[var(--ff-text-tertiary)]">to</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} className="ff-input text-sm" />
              <button onClick={() => window.open(`/api/accounting/reports/item-movement?from=${from}&to=${to}&format=csv`, '_blank')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg">
                <Download className="h-4 w-4" /> CSV
              </button>
            </div>
          </div>
        </div>
        <div className="p-6">
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
            ) : rows.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-tertiary)]">No stock movements for this period</div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Date</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Reference</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Item</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">In</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Out</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Balance</th>
                </tr></thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {rows.map((r, i) => (
                    <tr key={i} className="hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{r.date}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${r.type === 'GRN' ? 'bg-teal-500/10 text-teal-400' : 'bg-amber-500/10 text-amber-400'}`}>
                          {r.type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)]">{r.reference}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{r.itemName}</td>
                      <td className="px-4 py-3 text-right text-teal-400">{r.qtyIn > 0 ? r.qtyIn : ''}</td>
                      <td className="px-4 py-3 text-right text-red-400">{r.qtyOut > 0 ? r.qtyOut : ''}</td>
                      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">{r.balance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
