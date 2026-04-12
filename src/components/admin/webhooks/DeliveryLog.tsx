/**
 * DeliveryLog — expandable delivery attempt history for a webhook row.
 */

import { useState } from 'react';
import { Loader2, RefreshCw, CheckCircle, XCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { AdminWebhookDetail, DeliveryAttempt } from '@/modules/admin/services/adminWebhookService';

interface Props {
  webhookId: string;
}

const fmtDate = (d: string) =>
  new Date(d).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' });

function DeliveryRow({ d }: { d: DeliveryAttempt }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-gray-700/50 last:border-0 text-xs">
      {d.success ? (
        <CheckCircle className="w-3.5 h-3.5 text-teal-400 flex-shrink-0" />
      ) : (
        <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
      )}
      <span className="text-gray-400 w-28 flex-shrink-0">{fmtDate(d.deliveredAt)}</span>
      <span className="font-mono text-gray-300 flex-shrink-0 w-20">{d.event}</span>
      <span
        className={[
          'px-1.5 py-0.5 rounded font-mono flex-shrink-0',
          d.responseStatus
            ? d.responseStatus < 300
              ? 'bg-teal-500/10 text-teal-400'
              : 'bg-red-500/10 text-red-400'
            : 'bg-gray-700 text-gray-400',
        ].join(' ')}
      >
        {d.responseStatus ?? '—'}
      </span>
      {d.responseBody && (
        <span className="text-gray-500 truncate max-w-xs" title={d.responseBody}>
          {d.responseBody.slice(0, 80)}
        </span>
      )}
    </div>
  );
}

export function DeliveryLog({ webhookId }: Props) {
  const [detail, setDetail]       = useState<AdminWebhookDetail | null>(null);
  const [loading, setLoading]     = useState(false);
  const [redelivering, setRedelivering] = useState(false);
  const [toast, setToast]         = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const res  = await apiFetch(`/api/admin/webhooks/${webhookId}`, { credentials: 'include' });
      const json = await res.json() as { data: AdminWebhookDetail };
      setDetail(json.data);
    } catch {
      showToast('Failed to load deliveries');
    } finally {
      setLoading(false);
    }
  };

  const redeliver = async () => {
    setRedelivering(true);
    try {
      const res  = await apiFetch(`/api/admin/webhooks/${webhookId}/redeliver`, {
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const j = await res.json() as { error?: { message?: string } };
        showToast(j.error?.message ?? 'Redeliver failed');
      } else {
        showToast('Delivery queued for retry');
        await load();
      }
    } catch {
      showToast('Redeliver request failed');
    } finally {
      setRedelivering(false);
    }
  };

  // Auto-load on first render of this component
  if (!detail && !loading) {
    void load();
  }

  const hasFailedDelivery = detail?.deliveries.some((d) => !d.success);

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-700 p-4 mt-2">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Last 20 Deliveries
        </p>
        <div className="flex items-center gap-2">
          {hasFailedDelivery && (
            <button
              onClick={redeliver}
              disabled={redelivering}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
            >
              {redelivering ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Redeliver Last Failed
            </button>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="text-gray-500 hover:text-gray-300 transition-colors"
            title="Refresh deliveries"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {toast && (
        <div className="mb-2 px-3 py-2 rounded-lg bg-gray-700 text-xs text-gray-200">{toast}</div>
      )}

      {loading && !detail ? (
        <div className="flex justify-center py-4">
          <Loader2 className="w-5 h-5 animate-spin text-gray-500" />
        </div>
      ) : detail?.deliveries.length === 0 ? (
        <p className="text-xs text-gray-500 py-2">No deliveries recorded yet.</p>
      ) : (
        <div>
          {detail?.deliveries.map((d) => <DeliveryRow key={d.id} d={d} />)}
        </div>
      )}
    </div>
  );
}
