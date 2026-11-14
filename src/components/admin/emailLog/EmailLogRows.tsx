import { Fragment } from 'react';
import { Send } from 'lucide-react';
import type { EmailLogItem } from '../../../../pages/api/admin/email-log';
import { fmtDate, RESEND_UNAVAILABLE, STATUS_COLORS, TYPE_LABELS } from './emailLogLabels';

interface Props {
  items: EmailLogItem[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}

export function EmailLogRows({ items, expandedId, onToggle }: Props) {
  return (
    <>
    {items.map(item => {
      const isFailed  = item.status === 'failed';
      const isExpanded = expandedId === item.id;
      return (
        <Fragment key={item.id}>
          <tr
            className={`transition-colors cursor-pointer ${ isFailed ? 'bg-red-900/10 hover:bg-red-900/20' : 'hover:bg-gray-100 dark:hover:bg-gray-700/30' }`}
            onClick={() => onToggle(item.id)}
          >
            <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400 whitespace-nowrap">
              {fmtDate(item.sent_at)}
            </td>
            <td className="px-4 py-3 text-xs text-gray-700 dark:text-gray-300 max-w-[140px] truncate">
              {item.company_name ?? <span className="italic text-ink-faint">—</span>}
            </td>
            <td className="px-4 py-3 text-xs text-gray-700 dark:text-gray-300 max-w-[180px] truncate">
              {item.recipient_email}
            </td>
            <td className="px-4 py-3 text-xs text-gray-700 dark:text-gray-300 max-w-[220px] truncate">
              {item.subject}
            </td>
            <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
              {TYPE_LABELS[item.email_type] ?? item.email_type}
            </td>
            <td className="px-4 py-3">
              <span className={`inline-block px-2 py-0.5 text-xs rounded-full capitalize ${STATUS_COLORS[item.status] ?? ''}`}>
                {item.status}
              </span>
            </td>
            <td className="px-4 py-3 whitespace-nowrap" onClick={e => e.stopPropagation()}>
              {isFailed && (
                <span className="inline-flex flex-col items-start gap-0.5">
                  <button
                    type="button"
                    disabled
                    title={RESEND_UNAVAILABLE}
                    aria-describedby={`resend-why-${item.id}`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-amber-400 border border-amber-500/40 rounded opacity-50 cursor-not-allowed"
                  >
                    <Send className="w-3 h-3" />
                    Resend
                  </button>
                  <span id={`resend-why-${item.id}`} className="text-xs text-gray-600 dark:text-gray-400" title={RESEND_UNAVAILABLE}>
                    No copy of the email is kept
                  </span>
                </span>
              )}
            </td>
          </tr>
          {isExpanded && item.error_message && (
            <tr key={`${item.id}-err`} className="bg-red-900/10">
              <td colSpan={7} className="px-6 py-2">
                <p className="text-xs text-red-400 font-mono break-all">
                  Error: {item.error_message}
                </p>
              </td>
            </tr>
          )}
          {isExpanded && !item.error_message && (
            <tr key={`${item.id}-detail`} className="bg-gray-100 dark:bg-gray-700/20">
              <td colSpan={7} className="px-6 py-2">
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  ID: <span className="font-mono text-gray-700 dark:text-gray-300">{item.id}</span>
                  {item.sent_by && (
                    <> · Sent by: <span className="font-mono text-gray-700 dark:text-gray-300">{item.sent_by}</span></>
                  )}
                </p>
              </td>
            </tr>
          )}
        </Fragment>
      );
    })}
    </>
  );
}
