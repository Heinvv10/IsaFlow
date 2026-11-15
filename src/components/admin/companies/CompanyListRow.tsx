/**
 * One company in the list: the whole row opens the company; the checkbox cell and the action buttons do not.
 */
import { Loader2, ShieldCheck, ShieldOff, UserCog } from 'lucide-react';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { formatLastSeen } from '@/components/admin/formatLastSeen';
import { STATUS_BADGE } from './companyDetailModel';
import type { Company } from './companyListModel';

interface CompanyListRowProps {
  c: Company;
  selected: boolean;
  actionLoading: string | null;
  onOpen: () => void;
  toggleRow: (id: string) => void;
  handleImpersonate: (e: React.MouseEvent, companyId: string) => void;
  onSuspend: () => void;
  handleActivate: (e: React.MouseEvent, companyId: string, action: 'activate' | 'restore') => Promise<void>;
}

export function CompanyListRow({ c, selected, actionLoading, onOpen, toggleRow, handleImpersonate, onSuspend, handleActivate }: CompanyListRowProps) {
  return (
    <tr
      key={c.id}
      className={`border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer transition-colors ${selected ? 'bg-teal-50/50 dark:bg-teal-900/10' : ''}`}
      onClick={onOpen}
    >
      {/* The cell toggles only for a click on its padding: a click on the box already fired onChange, and
          toggling here too undid it (the box never ticked). */}
      <td className="px-3 py-3 w-8" onClick={e => { e.stopPropagation(); if (e.target === e.currentTarget) toggleRow(c.id); }}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => toggleRow(c.id)}
          className="rounded border-gray-300 dark:border-gray-600 text-teal-600 focus:ring-teal-500"
          aria-label={`Select ${c.name}`}
        />
      </td>
      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{c.name}</td>
      <td className="px-4 py-3 text-gray-600 dark:text-gray-300 capitalize">{c.plan_name}</td>
      <td className="px-4 py-3">
        <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[c.status] ?? ''}`}>
          {c.status}
        </span>
      </td>
      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{c.user_count}</td>
      <td className="px-4 py-3 text-gray-600 dark:text-gray-300 tabular-nums text-xs">{formatCurrency(c.mrr_cents / 100)}</td>
      <td className="px-4 py-3 text-ink-faint dark:text-gray-400 whitespace-nowrap">{formatDate(c.created_at)}</td>
      <td className="px-4 py-3 text-ink-faint dark:text-gray-400 whitespace-nowrap">{formatLastSeen(c.last_active)}</td>
      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          <button
            title="View / Impersonate"
            onClick={e => handleImpersonate(e, c.id)}
            disabled={actionLoading !== null}
            className="p-1.5 rounded text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors disabled:opacity-50"
          >
            <UserCog className="w-4 h-4" />
          </button>
          {c.status !== 'suspended' && c.status !== 'deleted'
            ? <button
                title="Suspend"
                onClick={e => { e.stopPropagation(); onSuspend(); }}
                disabled={actionLoading !== null}
                className="p-1.5 rounded text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-500/10 transition-colors disabled:opacity-50"
              >
                {actionLoading === c.id + ':suspend'
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <ShieldOff className="w-4 h-4" />
                }
              </button>
            : <button
                title={c.status === 'deleted' ? 'Restore' : 'Activate'}
                onClick={e => void handleActivate(e, c.id, c.status === 'deleted' ? 'restore' : 'activate')}
                disabled={actionLoading !== null}
                className="p-1.5 rounded text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-500/10 transition-colors disabled:opacity-50"
              >
                {actionLoading === c.id + ':activate'
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <ShieldCheck className="w-4 h-4" />
                }
              </button>
          }
        </div>
      </td>
    </tr>
  );
}
