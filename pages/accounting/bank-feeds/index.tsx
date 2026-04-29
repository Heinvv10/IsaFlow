/**
 * Open Banking — Bank Feeds Management
 * List connections, add new connections, trigger manual syncs, view sync history.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Wifi, WifiOff, Loader2, Plus } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { BankFeedCard } from '@/components/accounting/bankFeeds/BankFeedCard';
import { AddConnectionModal } from '@/components/accounting/bankFeeds/AddConnectionModal';
import type { BankFeedConnection, SyncLog, BankAccount } from '@/components/accounting/bankFeeds/bankFeedTypes';

export default function BankFeedsPage() {
  const [connections, setConnections] = useState<BankFeedConnection[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [expandedLogs, setExpandedLogs] = useState<string | null>(null);
  const [syncLogs, setSyncLogs] = useState<Record<string, SyncLog[]>>({});
  const [logsLoading, setLogsLoading] = useState<string | null>(null);

  const fetchConnections = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/bank-feeds');
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || 'Failed');
      setConnections(json.data?.items ?? []);
    } catch {
      notify.error('Failed to load bank feed connections');
    }
  }, []);

  const fetchBankAccounts = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/bank-accounts');
      const json = await res.json();
      if (res.ok) {
        // The bank-accounts endpoint returns the rows directly under `data`
        // as an array, not under `data.items`. Tolerate both shapes so this
        // doesn't regress when the API is normalised.
        const items = Array.isArray(json.data)
          ? json.data
          : Array.isArray(json.data?.items)
            ? json.data.items
            : [];
        setBankAccounts(items.map((a: Record<string, unknown>) => ({
          id: String(a.id),
          accountName: String(a.accountName ?? a.account_name ?? ''),
        })));
      }
    } catch { /* optional — proceed without bank accounts */ }
  }, []);

  useEffect(() => {
    setLoading(true);
    void Promise.all([fetchConnections(), fetchBankAccounts()]).finally(() => setLoading(false));
  }, [fetchConnections, fetchBankAccounts]);

  const handleSync = async (connectionId: string) => {
    setSyncing(connectionId);
    try {
      const res = await apiFetch(`/api/accounting/bank-feeds/${connectionId}/sync`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || 'Sync failed');
      const r = json.data as { imported?: number; duplicate?: number; instructions?: string };
      if (r.instructions) {
        notify.info(r.instructions);
      } else {
        notify.success(`Sync done: ${r.imported ?? 0} imported, ${r.duplicate ?? 0} duplicates`);
      }
      await fetchConnections();
      if (expandedLogs === connectionId) await loadSyncLogs(connectionId);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(null);
    }
  };

  const handleDelete = async (connectionId: string) => {
    if (!confirm('Delete this bank feed connection?')) return;
    setDeleting(connectionId);
    try {
      const res = await apiFetch(`/api/accounting/bank-feeds/${connectionId}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || 'Delete failed');
      notify.success('Connection deleted');
      await fetchConnections();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(null);
    }
  };

  const loadSyncLogs = async (connectionId: string) => {
    setLogsLoading(connectionId);
    try {
      const res = await apiFetch(`/api/accounting/bank-feeds/${connectionId}/logs`);
      const json = await res.json();
      if (res.ok) setSyncLogs(prev => ({ ...prev, [connectionId]: json.data?.items ?? [] }));
    } catch { /* fail silently */ }
    finally { setLogsLoading(null); }
  };

  const toggleLogs = async (connectionId: string) => {
    if (expandedLogs === connectionId) { setExpandedLogs(null); return; }
    setExpandedLogs(connectionId);
    if (!syncLogs[connectionId]) await loadSyncLogs(connectionId);
  };

  const handleCreated = async () => {
    setShowAddModal(false);
    await fetchConnections();
  };

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-teal-500/10 ring-1 ring-teal-500/20">
              <Wifi className="h-6 w-6 text-teal-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Bank Feeds</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Automated open banking transaction imports
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-semibold transition-colors"
          >
            <Plus className="h-4 w-4" /> Add Connection
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
          </div>
        ) : connections.length === 0 ? (
          <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-10 text-center">
            <WifiOff className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-2">No Bank Feed Connections</h2>
            <p className="text-sm text-[var(--ff-text-secondary)] mb-6 max-w-sm mx-auto">
              Connect your bank accounts to automatically import transactions via Basiq, Tink, Plaid, or manual CSV upload.
            </p>
            <button
              onClick={() => setShowAddModal(true)}
              className="px-6 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-semibold transition-colors"
            >
              Add Your First Connection
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {connections.map(conn => (
              <BankFeedCard
                key={conn.id}
                connection={conn}
                logs={syncLogs[conn.id] ?? []}
                logsOpen={expandedLogs === conn.id}
                logsLoading={logsLoading === conn.id}
                isSyncing={syncing === conn.id}
                isDeleting={deleting === conn.id}
                onSync={() => void handleSync(conn.id)}
                onDelete={() => void handleDelete(conn.id)}
                onToggleLogs={() => void toggleLogs(conn.id)}
              />
            ))}
          </div>
        )}
      </div>

      {showAddModal && (
        <AddConnectionModal
          bankAccounts={bankAccounts}
          onClose={() => setShowAddModal(false)}
          onCreated={() => void handleCreated()}
        />
      )}
    </AppLayout>
  );
}
