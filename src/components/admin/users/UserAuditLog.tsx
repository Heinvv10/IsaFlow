/**
 * UserAuditLog
 * Displays recent audit trail entries for a specific admin user detail page.
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { formatDate } from '@/utils/formatters';
import { AlertCircle, Loader2 } from 'lucide-react';
import { log } from '@/lib/logger';

interface AuditEntry {
  id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  created_at: string;
  admin_id: string;
  ip_address: string | null;
  metadata: Record<string, unknown> | null;
}

interface Props {
  userId: string;
}

export function UserAuditLog({ userId }: Props) {
  const [entries, setEntries]   = useState<AuditEntry[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res  = await apiFetch(`/api/admin/audit?entity_type=user&entity_id=${userId}&limit=20`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load audit log');
      setEntries((json.data?.items ?? []) as AuditEntry[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load audit log';
      log.error('UserAuditLog load failed', { userId, error: err }, 'admin-ui');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Audit Log</h3>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 m-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-teal-500" />
        </div>
      )}

      {!loading && !error && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Entity</th>
                <th className="px-4 py-3 font-medium">IP</th>
                <th className="px-4 py-3 font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No audit entries found</td></tr>
              )}
              {entries.map(e => (
                <tr key={e.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                  <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">{e.action}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs">
                    {e.entity_type ?? '\u2014'}{e.entity_id ? ` / ${e.entity_id.slice(0, 8)}…` : ''}
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">{e.ip_address ?? '\u2014'}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs whitespace-nowrap">{formatDate(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
