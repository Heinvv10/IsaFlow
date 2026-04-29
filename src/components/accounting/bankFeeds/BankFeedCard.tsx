/**
 * BankFeedCard — displays a single bank feed connection with
 * status badges, sync/delete actions, and an expandable sync-log panel.
 */

import { useState } from 'react';
import {
  Wifi, RefreshCw, Loader2, Trash2,
  ChevronDown, ChevronRight, AlertCircle, Clock,
  CheckCircle2, XCircle,
} from 'lucide-react';
import {
  PROVIDER_LABELS, STATUS_STYLES, SYNC_STATUS_STYLES, fmtDate,
  type BankFeedConnection, type SyncLog,
} from './bankFeedTypes';

const ABSA_MAX_DAYS = 180;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayIso(): string { return new Date().toISOString().slice(0, 10); }

interface SyncRange { fromDate: string; toDate: string }

interface Props {
  connection: BankFeedConnection;
  logs: SyncLog[];
  logsOpen: boolean;
  logsLoading: boolean;
  isSyncing: boolean;
  isDeleting: boolean;
  onSync: (range?: SyncRange) => void;
  onDelete: () => void;
  onToggleLogs: () => void;
}

function SyncLogsTable({ logs }: { logs: SyncLog[] }) {
  if (logs.length === 0) {
    return (
      <p className="px-5 pb-4 text-sm text-[var(--ff-text-tertiary)]">
        No sync history yet — click Sync to run the first sync.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--ff-border-primary)]">
            {['Started', 'Status', 'Found', 'Imported', 'Duplicates', 'Duration'].map(h => (
              <th key={h} className="px-4 py-2 text-left font-medium text-[var(--ff-text-secondary)]">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--ff-border-primary)]">
          {logs.map(entry => {
            const style = SYNC_STATUS_STYLES[entry.status] ?? SYNC_STATUS_STYLES['success']!;
            const durationMs = entry.completedAt
              ? new Date(entry.completedAt).getTime() - new Date(entry.startedAt).getTime()
              : null;
            const duration = durationMs != null
              ? durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`
              : '—';
            return (
              <tr key={entry.id} className="hover:bg-[var(--ff-bg-hover)]">
                <td className="px-4 py-2.5 text-[var(--ff-text-primary)]">{fmtDate(entry.startedAt)}</td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${style.cls}`}>
                    {entry.status === 'success' && <CheckCircle2 className="h-3 w-3" />}
                    {entry.status === 'failed' && <XCircle className="h-3 w-3" />}
                    {style.label}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-[var(--ff-text-secondary)]">{entry.transactionsFound}</td>
                <td className="px-4 py-2.5 text-teal-400 font-medium">{entry.transactionsImported}</td>
                <td className="px-4 py-2.5 text-[var(--ff-text-tertiary)]">{entry.transactionsDuplicate}</td>
                <td className="px-4 py-2.5 text-[var(--ff-text-tertiary)]">{duration}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {logs[0]?.errorMessage && (
        <p className="px-5 py-3 text-xs text-red-400 border-t border-[var(--ff-border-primary)]">
          Last error: {logs[0].errorMessage}
        </p>
      )}
    </div>
  );
}

export function BankFeedCard({
  connection: conn, logs, logsOpen, logsLoading,
  isSyncing, isDeleting, onSync, onDelete, onToggleLogs,
}: Props) {
  const statusStyle = STATUS_STYLES[conn.status] ?? STATUS_STYLES['active']!;
  const syncStyle = conn.lastSyncStatus ? (SYNC_STATUS_STYLES[conn.lastSyncStatus] ?? null) : null;
  const isExtension = conn.provider === 'extension';

  // Default range: 30 days back, OR since last sync if that's older.
  // (Defaulting to "since last sync" alone gives a 0-day range when the user
  // syncs twice in one day — produces an empty fetch and looks broken.)
  // Capped at 180 days to match ABSA's server-side limit.
  const minFrom = isoDaysAgo(ABSA_MAX_DAYS);
  const lastSyncIso = conn.lastSyncAt ? new Date(conn.lastSyncAt).toISOString().slice(0, 10) : null;
  const thirtyDaysAgo = isoDaysAgo(30);
  let defaultFrom = lastSyncIso && lastSyncIso < thirtyDaysAgo ? lastSyncIso : thirtyDaysAgo;
  if (defaultFrom < minFrom) defaultFrom = minFrom;
  const [fromDate, setFromDate] = useState<string>(defaultFrom);
  const [toDate, setToDate] = useState<string>(todayIso());

  const triggerSync = () => {
    if (isExtension) onSync({ fromDate, toDate });
    else onSync();
  };

  const setPreset = (days: number) => {
    setFromDate(isoDaysAgo(days));
    setToDate(todayIso());
  };

  return (
    <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl overflow-hidden">
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-10 h-10 bg-teal-500/10 rounded-lg flex items-center justify-center flex-shrink-0">
              <Wifi className="h-5 w-5 text-teal-400" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-[var(--ff-text-primary)] truncate">
                {conn.accountName ?? PROVIDER_LABELS[conn.provider]}
              </p>
              <p className="text-xs text-[var(--ff-text-secondary)] mt-0.5">
                {PROVIDER_LABELS[conn.provider]}
                {conn.externalAccountId && ` • ${conn.externalAccountId}`}
              </p>
              {conn.lastSyncAt && (
                <p className="text-xs text-[var(--ff-text-tertiary)] mt-1 flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Last sync: {fmtDate(conn.lastSyncAt)}
                </p>
              )}
              {conn.lastSyncError && (
                <p className="text-xs text-red-400 mt-1 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3 flex-shrink-0" />
                  {conn.lastSyncError}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusStyle.cls}`}>
              {statusStyle.label}
            </span>
            {syncStyle && (
              <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${syncStyle.cls}`}>
                {syncStyle.label}
              </span>
            )}
            <button
              onClick={triggerSync}
              disabled={isSyncing}
              title="Sync Now"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
            >
              {isSyncing
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <RefreshCw className="h-3.5 w-3.5" />}
              Sync
            </button>
            <button
              onClick={onToggleLogs}
              title="View sync history"
              className="p-1.5 text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
            >
              {logsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            <button
              onClick={onDelete}
              disabled={isDeleting}
              title="Delete connection"
              className="p-1.5 text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
            >
              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      {isExtension && (
        <div className="px-5 pb-4 -mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--ff-text-secondary)]">
          <span>Sync from</span>
          <input
            type="date"
            value={fromDate}
            min={minFrom}
            max={todayIso()}
            onChange={e => setFromDate(e.target.value)}
            className="ff-input py-1 px-2 text-xs"
          />
          <span>to</span>
          <input
            type="date"
            value={toDate}
            min={minFrom}
            max={todayIso()}
            onChange={e => setToDate(e.target.value)}
            className="ff-input py-1 px-2 text-xs"
          />
          {[7, 30, 90, 180].map(d => (
            <button
              key={d}
              onClick={() => setPreset(d)}
              type="button"
              className="px-2 py-0.5 border border-[var(--ff-border-primary)] rounded text-xs hover:bg-[var(--ff-bg-hover)]"
            >
              {d}d
            </button>
          ))}
          <span className="text-[10px] text-[var(--ff-text-tertiary)] ml-1">
            ABSA caps server-side at 180 days
          </span>
        </div>
      )}

      {logsOpen && (
        <div className="border-t border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-5 py-3 flex items-center justify-between">
            <p className="text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wide">
              Sync History
            </p>
            {logsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--ff-text-tertiary)]" />}
          </div>
          <SyncLogsTable logs={logs} />
        </div>
      )}
    </div>
  );
}
