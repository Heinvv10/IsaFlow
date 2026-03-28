/**
 * Bank Feeds — Manage live bank connections via Stitch
 * Connect bank accounts, sync transactions, view sync history
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  Wifi, WifiOff, RefreshCw, Loader2, AlertCircle, CheckCircle2,
  Link2, Unlink, Clock, ArrowDownCircle, XCircle,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Connection {
  id: string;
  bankAccountId: string;
  bankAccountName?: string;
  provider: string;
  bankName: string | null;
  accountNumberMasked: string | null;
  branchCode: string | null;
  lastSyncAt: string | null;
  syncStatus: string;
  syncError: string | null;
  isActive: boolean;
}

interface SyncLog {
  id: string;
  syncType: string;
  fetched: number;
  imported: number;
  skipped: number;
  startedAt: string;
  completedAt: string | null;
  status: string;
  error: string | null;
}

const SYNC_STATUS_STYLES: Record<string, { cls: string; label: string }> = {
  synced: { cls: 'bg-teal-500/20 text-teal-500', label: 'Connected' },
  syncing: { cls: 'bg-blue-500/20 text-blue-500', label: 'Syncing...' },
  pending: { cls: 'bg-amber-500/20 text-amber-500', label: 'Pending' },
  error: { cls: 'bg-red-500/20 text-red-500', label: 'Error' },
};

export default function BankFeedsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [selectedHistory, setSelectedHistory] = useState<{ connectionId: string; logs: SyncLog[] } | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, connRes] = await Promise.all([
        apiFetch('/api/bank-feeds/connections?action=status'),
        apiFetch('/api/bank-feeds/connections'),
      ]);
      const statusJson = await statusRes.json();
      const connJson = await connRes.json();
      setConfigured(statusJson.data?.configured ?? false);
      setConnections(connJson.data?.items ?? []);
    } catch {
      setError('Failed to load connections');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const handleConnect = async () => {
    setError('');
    try {
      const res = await apiFetch('/api/bank-feeds/connect');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed');
      window.location.href = json.data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initiate connection');
    }
  };

  const handleSync = async (connectionId: string) => {
    setSyncing(connectionId);
    setError('');
    setSuccess('');
    try {
      const res = await apiFetch('/api/bank-feeds/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync', connectionId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Sync failed');
      const r = json.data;
      setSuccess(`Synced: ${r.imported} new transactions imported, ${r.skipped} duplicates skipped`);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(null);
    }
  };

  const handleDisconnect = async (connectionId: string) => {
    try {
      await apiFetch('/api/bank-feeds/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect', connectionId }),
      });
      await fetchData();
    } catch {
      setError('Failed to disconnect');
    }
  };

  const handleViewHistory = async (connectionId: string) => {
    try {
      const res = await apiFetch(`/api/bank-feeds/connections?action=history&connectionId=${connectionId}`);
      const json = await res.json();
      setSelectedHistory({ connectionId, logs: json.data?.items ?? [] });
    } catch {
      setError('Failed to load sync history');
    }
  };

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Wifi className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Bank Feeds</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Live bank transaction sync via Stitch
              </p>
            </div>
          </div>
          {configured && (
            <button
              onClick={() => void handleConnect()}
              className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Link2 className="h-4 w-4" />
              Connect Bank
            </button>
          )}
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-2 text-red-500 text-sm">
            <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
            <button onClick={() => setError('')} className="ml-auto"><XCircle className="h-4 w-4" /></button>
          </div>
        )}
        {success && (
          <div className="bg-teal-500/10 border border-teal-500/30 rounded-lg p-3 flex items-center gap-2 text-teal-500 text-sm">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0" /> {success}
            <button onClick={() => setSuccess('')} className="ml-auto"><XCircle className="h-4 w-4" /></button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
          </div>
        ) : configured === false ? (
          <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-8 text-center">
            <WifiOff className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-2">Bank Feeds Not Configured</h2>
            <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
              Set the following environment variables to enable live bank feeds:
            </p>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg p-4 text-left max-w-md mx-auto font-mono text-xs text-[var(--ff-text-secondary)]">
              <p>STITCH_CLIENT_ID=your_client_id</p>
              <p>STITCH_CLIENT_SECRET=your_secret</p>
              <p>STITCH_REDIRECT_URI=https://app.isaflow.co.za/api/bank-feeds/callback</p>
            </div>
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-4">
              Sign up at stitch.money to get your API credentials
            </p>
          </div>
        ) : connections.length === 0 ? (
          <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-8 text-center">
            <Wifi className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-2">No Bank Connections</h2>
            <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
              Connect your bank account to automatically import transactions daily.
            </p>
            <button
              onClick={() => void handleConnect()}
              className="px-6 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Connect Your First Bank
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {connections.map(conn => {
              const status = SYNC_STATUS_STYLES[conn.syncStatus] ?? SYNC_STATUS_STYLES['pending']!;
              return (
                <div
                  key={conn.id}
                  className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-5"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-teal-500/10 rounded-lg flex items-center justify-center">
                        <Wifi className="h-5 w-5 text-teal-500" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-[var(--ff-text-primary)]">
                          {conn.bankAccountName || conn.bankName || 'Bank Account'}
                        </h3>
                        <p className="text-xs text-[var(--ff-text-secondary)]">
                          {conn.bankName && `${conn.bankName} • `}
                          {conn.accountNumberMasked && `${conn.accountNumberMasked} • `}
                          {conn.provider}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${status.cls}`}>
                        {status.label}
                      </span>
                      <button
                        onClick={() => void handleSync(conn.id)}
                        disabled={syncing === conn.id}
                        className="flex items-center gap-1 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                      >
                        {syncing === conn.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        Sync Now
                      </button>
                      <button
                        onClick={() => void handleViewHistory(conn.id)}
                        className="p-1.5 text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
                        title="View sync history"
                      >
                        <Clock className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => void handleDisconnect(conn.id)}
                        className="p-1.5 text-red-400 hover:text-red-500 transition-colors"
                        title="Disconnect"
                      >
                        <Unlink className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {conn.lastSyncAt && (
                    <p className="text-xs text-[var(--ff-text-tertiary)] mt-2 ml-14">
                      Last synced: {new Date(conn.lastSyncAt).toLocaleString('en-ZA')}
                    </p>
                  )}
                  {conn.syncError && (
                    <p className="text-xs text-red-400 mt-1 ml-14">{conn.syncError}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Sync History Modal */}
        {selectedHistory && (
          <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-[var(--ff-border-primary)] flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Sync History</h2>
              <button onClick={() => setSelectedHistory(null)} className="text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
                <XCircle className="h-5 w-5" />
              </button>
            </div>
            {selectedHistory.logs.length === 0 ? (
              <p className="p-6 text-center text-[var(--ff-text-secondary)]">No sync history yet</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[var(--ff-bg-secondary)]">
                    <th className="text-left px-4 py-2.5 font-medium text-[var(--ff-text-secondary)]">Date</th>
                    <th className="text-left px-4 py-2.5 font-medium text-[var(--ff-text-secondary)]">Type</th>
                    <th className="text-right px-4 py-2.5 font-medium text-[var(--ff-text-secondary)]">Fetched</th>
                    <th className="text-right px-4 py-2.5 font-medium text-[var(--ff-text-secondary)]">Imported</th>
                    <th className="text-right px-4 py-2.5 font-medium text-[var(--ff-text-secondary)]">Skipped</th>
                    <th className="text-center px-4 py-2.5 font-medium text-[var(--ff-text-secondary)]">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-primary)]">
                  {selectedHistory.logs.map(log => (
                    <tr key={log.id} className="hover:bg-[var(--ff-bg-hover)]">
                      <td className="px-4 py-2.5 text-[var(--ff-text-primary)]">
                        {new Date(log.startedAt).toLocaleString('en-ZA')}
                      </td>
                      <td className="px-4 py-2.5 text-[var(--ff-text-secondary)] capitalize">{log.syncType}</td>
                      <td className="px-4 py-2.5 text-right text-[var(--ff-text-secondary)]">{log.fetched}</td>
                      <td className="px-4 py-2.5 text-right text-teal-500 font-medium">{log.imported}</td>
                      <td className="px-4 py-2.5 text-right text-[var(--ff-text-tertiary)]">{log.skipped}</td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          log.status === 'completed' ? 'bg-teal-500/20 text-teal-500' :
                          log.status === 'failed' ? 'bg-red-500/20 text-red-500' :
                          'bg-amber-500/20 text-amber-500'
                        }`}>
                          {log.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
