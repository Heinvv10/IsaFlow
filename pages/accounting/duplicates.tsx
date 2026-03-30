/**
 * Duplicate Detection & Merge Wizard
 * PRD: WS-6.6 — Detect and merge duplicate customers, suppliers, and items.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { Copy, Merge, Loader2, AlertCircle, CheckCircle, X } from 'lucide-react';
import { MergeDialog } from '@/components/accounting/duplicates/MergeDialog';
import type { MergeDialogState } from '@/components/accounting/duplicates/MergeDialog';
import type { DuplicatePair, DuplicateEntity } from '@/modules/accounting/services/duplicateDetectionService';

type EntityType = 'customer' | 'supplier' | 'item';

const TABS: { id: EntityType; label: string }[] = [
  { id: 'customer', label: 'Customers' },
  { id: 'supplier', label: 'Suppliers' },
  { id: 'item', label: 'Items' },
];

function confidenceClasses(c: number) {
  if (c >= 90) return 'bg-green-100 text-green-800 border-green-300';
  if (c >= 70) return 'bg-yellow-100 text-yellow-800 border-yellow-300';
  return 'bg-orange-100 text-orange-800 border-orange-300';
}

function EntityCard({ entity, label }: { entity: DuplicateEntity; label: string }) {
  return (
    <div className="flex-1 rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-secondary)] p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ff-text-muted)] mb-2">{label}</p>
      <p className="font-semibold text-[var(--ff-text-primary)] text-sm">{entity.name}</p>
      {entity.email && <p className="text-xs text-[var(--ff-text-secondary)] mt-1">{entity.email}</p>}
      {entity.vatNumber && <p className="text-xs text-[var(--ff-text-secondary)]">VAT: {entity.vatNumber}</p>}
      {(entity.phone as string | undefined) && <p className="text-xs text-[var(--ff-text-secondary)]">{entity.phone as string}</p>}
      {(entity.itemCode as string | undefined) && <p className="text-xs text-[var(--ff-text-secondary)]">Code: {entity.itemCode as string}</p>}
    </div>
  );
}

function DuplicatePairCard({ pair, pairKey, onDismiss, onMerge }: {
  pair: DuplicatePair;
  pairKey: string;
  onDismiss: () => void;
  onMerge: () => void;
}) {
  return (
    <div key={pairKey} className="rounded-xl border border-[var(--ff-border)] bg-[var(--ff-bg-secondary)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--ff-border)] bg-[var(--ff-bg-primary)]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${confidenceClasses(pair.confidence)}`}>
            {pair.confidence}% confidence
          </span>
          {pair.matchReasons.map((reason, i) => (
            <span key={i} className="text-xs text-[var(--ff-text-muted)] bg-[var(--ff-bg-secondary)] rounded-full px-2 py-0.5 border border-[var(--ff-border)]">
              {reason}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onDismiss} className="text-xs text-[var(--ff-text-muted)] hover:text-[var(--ff-text-primary)] px-3 py-1.5 rounded-lg border border-[var(--ff-border)] hover:bg-[var(--ff-bg-secondary)] transition-colors">
            Dismiss
          </button>
          <button onClick={onMerge} className="flex items-center gap-1.5 text-xs text-white bg-teal-600 hover:bg-teal-700 px-3 py-1.5 rounded-lg transition-colors">
            <Merge className="h-3.5 w-3.5" />
            Merge
          </button>
        </div>
      </div>
      <div className="flex gap-4 p-4">
        <EntityCard entity={pair.primary} label="Record A" />
        <div className="flex items-center">
          <div className="h-px w-6 bg-[var(--ff-border)]" />
          <span className="text-xs text-[var(--ff-text-muted)] px-1">vs</span>
          <div className="h-px w-6 bg-[var(--ff-border)]" />
        </div>
        <EntityCard entity={pair.duplicate} label="Record B" />
      </div>
    </div>
  );
}

export default function DuplicatesPage() {
  const { activeCompany } = useCompany();
  const [isMounted, setIsMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<EntityType>('customer');
  const [results, setResults] = useState<Record<EntityType, DuplicatePair[] | null>>({ customer: null, supplier: null, item: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [mergeDialog, setMergeDialog] = useState<MergeDialogState | null>(null);
  const [mergeSuccess, setMergeSuccess] = useState<string | null>(null);

  useEffect(() => {
    setIsMounted(true);
    try {
      const stored = localStorage.getItem('isaflow_dismissed_duplicates');
      if (stored) setDismissed(new Set(JSON.parse(stored) as string[]));
    } catch { /* ignore */ }
  }, []);

  const pairKey = useCallback((p: DuplicatePair) =>
    `${p.entityType}:${[p.primary.id, p.duplicate.id].sort().join(':')}`, []);

  const handleScan = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setError(null);
    setMergeSuccess(null);
    try {
      const res = await apiFetch(`/api/accounting/duplicates?entity_type=${activeTab}`);
      const json = await res.json() as { data: { duplicates: DuplicatePair[] } };
      setResults(prev => ({ ...prev, [activeTab]: json.data.duplicates }));
    } catch (err) {
      log.error('Duplicate scan failed', { error: err }, 'duplicates-page');
      setError('Failed to scan for duplicates. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [activeCompany, activeTab]);

  const handleDismiss = useCallback((pair: DuplicatePair) => {
    const key = pairKey(pair);
    setDismissed(prev => {
      const next = new Set(prev);
      next.add(key);
      try { localStorage.setItem('isaflow_dismissed_duplicates', JSON.stringify(Array.from(next))); } catch { /* ignore */ }
      return next;
    });
  }, [pairKey]);

  const handleMergeConfirm = useCallback(async (primaryId: string, duplicateId: string) => {
    if (!mergeDialog) return;
    setMergeDialog(prev => prev ? { ...prev, loading: true } : null);
    try {
      const res = await apiFetch('/api/accounting/duplicates-merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType: mergeDialog.pair.entityType, primaryId, duplicateId }),
      });
      const json = await res.json() as { data: { reassignedTransactions: number } };
      const count = json.data.reassignedTransactions;
      setMergeSuccess(`Merge complete. ${count} transaction${count !== 1 ? 's' : ''} reassigned.`);
      const key = pairKey(mergeDialog.pair);
      setDismissed(prev => {
        const next = new Set(prev);
        next.add(key);
        try { localStorage.setItem('isaflow_dismissed_duplicates', JSON.stringify(Array.from(next))); } catch { /* ignore */ }
        return next;
      });
      setMergeDialog(null);
    } catch (err) {
      log.error('Merge failed', { error: err }, 'duplicates-page');
      setMergeDialog(prev => prev ? { ...prev, loading: false } : null);
    }
  }, [mergeDialog, pairKey]);

  const currentResults = results[activeTab];
  const visiblePairs = currentResults?.filter(p => !dismissed.has(pairKey(p))) ?? [];

  if (!isMounted) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="max-w-5xl mx-auto px-4 py-8">

          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Copy className="h-6 w-6 text-teal-500" />
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Duplicate Detection</h1>
                <p className="text-sm text-[var(--ff-text-muted)] mt-0.5">Find and merge duplicate customers, suppliers, and items</p>
              </div>
            </div>
            <button
              onClick={() => void handleScan()}
              disabled={loading}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 transition-colors disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
              {loading ? 'Scanning…' : 'Scan for Duplicates'}
            </button>
          </div>

          {/* Banners */}
          {mergeSuccess && (
            <div className="flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 px-4 py-3 mb-4">
              <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0" />
              <p className="text-sm text-green-800">{mergeSuccess}</p>
              <button onClick={() => setMergeSuccess(null)} className="ml-auto text-green-600 hover:text-green-800"><X className="h-4 w-4" /></button>
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-4 py-3 mb-4">
              <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0" />
              <p className="text-sm text-red-800">{error}</p>
              <button onClick={() => setError(null)} className="ml-auto text-red-600 hover:text-red-800"><X className="h-4 w-4" /></button>
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-1 border-b border-[var(--ff-border)] mb-6">
            {TABS.map(tab => {
              const tabVisible = results[tab.id]?.filter(p => !dismissed.has(pairKey(p))).length ?? null;
              return (
                <button
                  key={tab.id}
                  onClick={() => { setActiveTab(tab.id); setError(null); }}
                  className={`px-5 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${activeTab === tab.id ? 'text-teal-600 border-b-2 border-teal-600 bg-[var(--ff-bg-secondary)]' : 'text-[var(--ff-text-muted)] hover:text-[var(--ff-text-primary)]'}`}
                >
                  {tab.label}
                  {tabVisible !== null && (
                    <span className={`ml-2 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold ${tabVisible > 0 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                      {tabVisible}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Results */}
          {currentResults === null && !loading && (
            <div className="text-center py-16 text-[var(--ff-text-muted)]">
              <Copy className="h-12 w-12 mx-auto mb-4 opacity-30" />
              <p className="text-sm">Click &quot;Scan for Duplicates&quot; to search for potential {activeTab} duplicates.</p>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-16 gap-3 text-[var(--ff-text-muted)]">
              <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
              <span className="text-sm">Scanning {TABS.find(t => t.id === activeTab)?.label.toLowerCase()}…</span>
            </div>
          )}

          {!loading && currentResults !== null && visiblePairs.length === 0 && (
            <div className="text-center py-16 text-[var(--ff-text-muted)]">
              <CheckCircle className="h-12 w-12 mx-auto mb-4 text-green-400" />
              <p className="text-sm font-medium text-[var(--ff-text-primary)]">No duplicates found</p>
              <p className="text-xs mt-1">No potential duplicate {activeTab}s were detected.</p>
            </div>
          )}

          {!loading && visiblePairs.length > 0 && (
            <div className="space-y-4">
              <p className="text-sm text-[var(--ff-text-muted)]">
                Found <strong className="text-[var(--ff-text-primary)]">{visiblePairs.length}</strong> potential duplicate pair{visiblePairs.length !== 1 ? 's' : ''}.
              </p>
              {visiblePairs.map(pair => (
                <DuplicatePairCard
                  key={pairKey(pair)}
                  pair={pair}
                  pairKey={pairKey(pair)}
                  onDismiss={() => handleDismiss(pair)}
                  onMerge={() => setMergeDialog({ pair, loading: false })}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {mergeDialog && (
        <MergeDialog
          state={mergeDialog}
          onConfirm={handleMergeConfirm}
          onClose={() => setMergeDialog(null)}
        />
      )}
    </AppLayout>
  );
}
