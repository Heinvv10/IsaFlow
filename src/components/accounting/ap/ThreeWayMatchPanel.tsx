/**
 * ThreeWayMatchPanel — PRD-05 Phase 4
 * Displays 3-way (and 4-way) match state for a supplier invoice.
 * Loaded via apiFetch from: GET /api/accounting/supplier-invoices/[id]/three-way-match
 */

import { useState, useEffect, useCallback } from 'react';
import { Loader2, AlertCircle, RefreshCw, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

// ─── API shape ────────────────────────────────────────────────────────────────

interface MatchItemResult {
  invoiceItemId: string;
  description: string;
  poQuantity: number;
  invoiceQuantity: number;
  grnQuantityReceived: number;
  poUnitPrice: number;
  invoiceUnitPrice: number;
  qtyVariancePct: number;
  priceVariancePct: number;
  lineMatchStatus: 'unmatched' | 'po_matched' | 'grn_matched' | 'fully_matched';
  mismatches: string[];
}

interface ThreeWayMatchState {
  invoiceId: string;
  matchStatus: 'unmatched' | 'po_matched' | 'grn_matched' | 'fully_matched';
  paymentMatched: boolean;
  paymentMatchedAt: string | null;
  hasPurchaseOrder: boolean;
  summary: {
    totalLines: number;
    fullyMatched: number;
    priceMismatches: number;
    quantityMismatches: number;
    grnMismatches: number;
  };
  itemResults: MatchItemResult[];
  tolerancesApplied: { qtyTolerancePct: number; priceTolerancePct: number };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtPct(val: number): string {
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(1)}%`;
}

function fmtZAR(val: number): string {
  return `R ${val.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MatchStatusBadge({ status }: { status: ThreeWayMatchState['matchStatus'] }) {
  const cfg = {
    fully_matched: { cls: 'bg-green-500/20 text-green-400', label: '3-way matched' },
    po_matched:    { cls: 'bg-amber-500/20 text-amber-400', label: 'PO matched, GRN pending' },
    grn_matched:   { cls: 'bg-amber-500/20 text-amber-400', label: 'GRN matched, price/qty differs' },
    unmatched:     { cls: 'bg-red-500/20 text-red-400',     label: 'Not matched' },
  } as const;
  const { cls, label } = cfg[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${cls}`}>
      {status === 'fully_matched'
        ? <CheckCircle2 className="h-3.5 w-3.5" />
        : status === 'unmatched'
          ? <XCircle className="h-3.5 w-3.5" />
          : <Clock className="h-3.5 w-3.5" />}
      {label}
    </span>
  );
}

function PaymentBadge({ matched, matchedAt }: { matched: boolean; matchedAt: string | null }) {
  if (matched) {
    const when = matchedAt ? new Date(matchedAt).toLocaleDateString('en-ZA') : null;
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-teal-500/20 text-teal-400">
        <CheckCircle2 className="h-3.5 w-3.5" />
        4-way matched{when ? ` · ${when}` : ''}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-slate-700/50 text-slate-500">
      Not paid
    </span>
  );
}

type VarianceLevel = 'ok' | 'warn' | 'error';

function varianceLevel(pct: number, tolerance: number): VarianceLevel {
  const abs = Math.abs(pct);
  if (abs === 0) return 'ok';
  if (abs <= tolerance) return 'warn';
  return 'error';
}

function VarianceCell({ pct, tolerance }: { pct: number; tolerance: number }) {
  const level = varianceLevel(pct, tolerance);
  const cls =
    level === 'ok'    ? 'text-green-400' :
    level === 'warn'  ? 'text-amber-400' :
                        'text-red-400';
  if (pct === 0) {
    return <span className="text-green-400 font-mono">—</span>;
  }
  return <span className={`font-mono font-medium ${cls}`}>{fmtPct(pct)}</span>;
}

function LineStatusBadge({ status }: { status: MatchItemResult['lineMatchStatus'] }) {
  const cfg = {
    fully_matched: 'bg-green-500/20 text-green-400',
    po_matched:    'bg-blue-500/20 text-blue-400',
    grn_matched:   'bg-amber-500/20 text-amber-400',
    unmatched:     'bg-red-500/20 text-red-400',
  } as const;
  const label = status.replace(/_/g, ' ');
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cfg[status]}`}>
      {label}
    </span>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

interface Props {
  invoiceId: string;
}

export function ThreeWayMatchPanel({ invoiceId }: Props) {
  const [state, setState] = useState<ThreeWayMatchState | null>(null);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/supplier-invoices/${invoiceId}/three-way-match`);
      const json = await res.json() as { data?: ThreeWayMatchState; error?: string };
      if (!res.ok) { setError(json.error ?? 'Failed to load match data'); return; }
      setState(json.data ?? null);
    } catch {
      setError('Network error loading match data');
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => { void load(); }, [load]);

  const recompute = async () => {
    setRecomputing(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/supplier-invoices/${invoiceId}/three-way-match`, { method: 'POST' });
      const json = await res.json() as { data?: ThreeWayMatchState; error?: string };
      if (!res.ok) { setError(json.error ?? 'Recompute failed'); return; }
      setState(json.data ?? null);
    } catch {
      setError('Network error recomputing match');
    } finally {
      setRecomputing(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 flex items-center gap-2 text-[var(--ff-text-secondary)] text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading match data…
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 flex items-center gap-2 text-red-400 text-sm">
        <AlertCircle className="h-4 w-4" /> {error}
      </div>
    );
  }

  if (!state || !state.hasPurchaseOrder) {
    return (
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 text-sm text-[var(--ff-text-tertiary)]">
        This invoice has no linked PO — 3-way match not applicable.
      </div>
    );
  }

  const { summary, itemResults, tolerancesApplied } = state;

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
      {/* Panel header */}
      <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">3-Way Match</h3>
          <MatchStatusBadge status={state.matchStatus} />
          <PaymentBadge matched={state.paymentMatched} matchedAt={state.paymentMatchedAt} />
        </div>
        <button
          onClick={() => void recompute()}
          disabled={recomputing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${recomputing ? 'animate-spin' : ''}`} />
          {recomputing ? 'Recomputing…' : 'Recompute match'}
        </button>
      </div>

      {/* Summary row */}
      <div className="px-6 py-3 border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] text-xs text-[var(--ff-text-secondary)] flex flex-wrap gap-x-4 gap-y-1">
        <span>
          <span className="font-semibold text-[var(--ff-text-primary)]">{summary.fullyMatched}</span>
          {' '}of{' '}
          <span className="font-semibold text-[var(--ff-text-primary)]">{summary.totalLines}</span>
          {' '}lines fully matched
        </span>
        {summary.priceMismatches > 0 && (
          <span className="text-amber-400">
            {summary.priceMismatches} price {summary.priceMismatches === 1 ? 'mismatch' : 'mismatches'}
          </span>
        )}
        {summary.quantityMismatches > 0 && (
          <span className="text-amber-400">
            {summary.quantityMismatches} qty {summary.quantityMismatches === 1 ? 'mismatch' : 'mismatches'}
          </span>
        )}
        {summary.grnMismatches > 0 && (
          <span className="text-amber-400">
            {summary.grnMismatches} GRN {summary.grnMismatches === 1 ? 'mismatch' : 'mismatches'}
          </span>
        )}
      </div>

      {/* Line items table */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
              {['Description', 'PO qty', 'Inv qty', 'Qty var', 'PO price', 'Inv price', 'Price var', 'Status'].map(h => (
                <th key={h} className={`px-4 py-3 text-xs font-medium text-[var(--ff-text-secondary)] uppercase ${h === 'Description' ? 'text-left' : 'text-right'} last:text-left`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ff-border-light)]">
            {itemResults.map(item => (
              <tr key={item.invoiceItemId} className="hover:bg-[var(--ff-bg-tertiary)]">
                <td className="px-4 py-3 text-[var(--ff-text-primary)] max-w-[200px] truncate" title={item.description}>
                  {item.description}
                </td>
                <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-secondary)]">
                  {item.poQuantity}
                </td>
                <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-secondary)]">
                  {item.invoiceQuantity}
                </td>
                <td className="px-4 py-3 text-right">
                  <VarianceCell pct={item.qtyVariancePct} tolerance={tolerancesApplied.qtyTolerancePct} />
                </td>
                <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-secondary)]">
                  {fmtZAR(item.poUnitPrice)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-secondary)]">
                  {fmtZAR(item.invoiceUnitPrice)}
                </td>
                <td className="px-4 py-3 text-right">
                  <VarianceCell pct={item.priceVariancePct} tolerance={tolerancesApplied.priceTolerancePct} />
                </td>
                <td className="px-4 py-3">
                  <LineStatusBadge status={item.lineMatchStatus} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="px-6 py-3 border-t border-[var(--ff-border-light)] text-xs text-[var(--ff-text-tertiary)]">
        Tolerances applied: qty ±{tolerancesApplied.qtyTolerancePct}% · price ±{tolerancesApplied.priceTolerancePct}%
      </div>
    </div>
  );
}
