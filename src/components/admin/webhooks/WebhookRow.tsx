/**
 * WebhookRow — single row in the admin webhooks table with expandable delivery log.
 */

import { Loader2, ChevronDown, ChevronRight, Trash2, ToggleLeft, ToggleRight } from 'lucide-react';
import { DeliveryLog } from './DeliveryLog';
import type { AdminWebhook } from '@/modules/admin/services/adminWebhookService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtDate = (d: string | null) => {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' });
};

const truncateUrl = (url: string, max = 48) =>
  url.length > max ? `${url.slice(0, max)}…` : url;

// ─── Badges ───────────────────────────────────────────────────────────────────

export function StatusBadge({ webhook }: { webhook: AdminWebhook }) {
  if (!webhook.isActive) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-600">
        Disabled
      </span>
    );
  }
  if (webhook.failureCount >= 5) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/30">
        Erroring ({webhook.failureCount})
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-teal-500/10 text-teal-400 border border-teal-500/30">
      Active
    </span>
  );
}

export function DeliveryBadge({ status }: { status: AdminWebhook['lastDeliveryStatus'] }) {
  if (status === 'none') return <span className="text-gray-500 text-xs">—</span>;
  if (status === 'success') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-teal-500/10 text-teal-400 border border-teal-500/30">
        OK
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-red-500/10 text-red-400 border border-red-500/30">
      Failed
    </span>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

interface Props {
  wh: AdminWebhook;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleStatus: (id: string, current: boolean) => void;
  onDelete: (id: string, url: string) => void;
  actionLoading: string | null;
}

export function WebhookRow({
  wh,
  expanded,
  onToggleExpand,
  onToggleStatus,
  onDelete,
  actionLoading,
}: Props) {
  const isLoading = actionLoading === wh.id;

  return (
    <>
      <tr
        className="border-b border-gray-200 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer transition-colors"
        onClick={onToggleExpand}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            {expanded
              ? <ChevronDown className="w-3.5 h-3.5 text-gray-600 dark:text-gray-400 flex-shrink-0" />
              : <ChevronRight className="w-3.5 h-3.5 text-gray-600 dark:text-gray-400 flex-shrink-0" />
            }
            <span className="text-sm font-medium text-slate-900 dark:text-white">{wh.companyName}</span>
          </div>
        </td>
        <td className="px-4 py-3">
          <span className="text-xs font-mono text-teal-300" title={wh.url}>
            {truncateUrl(wh.url)}
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap gap-1">
            {wh.events.slice(0, 3).map((e) => (
              <span key={e} className="px-1.5 py-0.5 rounded text-xs bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-mono">
                {e}
              </span>
            ))}
            {wh.events.length > 3 && (
              <span className="px-1.5 py-0.5 rounded text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
                +{wh.events.length - 3}
              </span>
            )}
          </div>
        </td>
        <td className="px-4 py-3"><StatusBadge webhook={wh} /></td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <DeliveryBadge status={wh.lastDeliveryStatus} />
            <span className="text-xs text-gray-500">{fmtDate(wh.lastDeliveryAt)}</span>
          </div>
        </td>
        <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">{fmtDate(wh.createdAt)}</td>
        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onToggleStatus(wh.id, wh.isActive)}
              disabled={isLoading}
              title={wh.isActive ? 'Disable webhook' : 'Enable webhook'}
              className="text-gray-600 dark:text-gray-400 hover:text-teal-400 disabled:opacity-40 transition-colors"
            >
              {isLoading
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : wh.isActive
                  ? <ToggleRight className="w-4 h-4 text-teal-400" />
                  : <ToggleLeft className="w-4 h-4" />
              }
            </button>
            <button
              onClick={() => onDelete(wh.id, wh.url)}
              disabled={isLoading}
              title="Delete webhook"
              className="text-gray-600 dark:text-gray-400 hover:text-red-400 disabled:opacity-40 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </td>
      </tr>

      {expanded && (
        <tr className="bg-gray-50 dark:bg-gray-800/20">
          <td colSpan={7} className="px-6 pb-4 pt-1">
            <DeliveryLog webhookId={wh.id} />
          </td>
        </tr>
      )}
    </>
  );
}
