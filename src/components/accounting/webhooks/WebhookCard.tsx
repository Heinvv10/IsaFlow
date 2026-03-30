/**
 * WebhookCard — single webhook entry with delivery log expansion
 */

import { ChevronDown, ChevronUp, CheckCircle, XCircle, Loader2, Trash2, Play } from 'lucide-react';
import type { Webhook, Delivery } from '@/modules/accounting/services/webhookService';

const BTN_GHOST = 'inline-flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] rounded-lg hover:bg-[var(--ff-bg-primary)] transition-colors';

interface Props {
  webhook: Webhook;
  deliveries: Delivery[] | undefined;
  expanded: boolean;
  testing: boolean;
  testResult: { success: boolean; status: number; body: string } | undefined;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
}

export function WebhookCard({ webhook: wh, deliveries, expanded, testing, testResult, onToggle, onEdit, onDelete, onTest }: Props) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-hidden">
      <div className="px-5 py-4 flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-[var(--ff-text-primary)]">{wh.name}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${wh.isActive ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
              {wh.isActive ? 'Active' : 'Disabled'}
            </span>
            {wh.failureCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 font-medium">
                {wh.failureCount} failure{wh.failureCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <p className="text-sm text-[var(--ff-text-secondary)] truncate mt-0.5">
            {wh.url.replace(/^(https?:\/\/[^/]+).*$/, '$1/***')}
          </p>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {wh.events.map(ev => (
              <span key={ev} className="text-xs font-mono px-1.5 py-0.5 bg-teal-500/10 text-teal-400 rounded">{ev}</span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {testResult && (
            <span className={`text-xs font-medium ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
              {testResult.success ? `OK ${testResult.status}` : `Fail ${testResult.status}`}
            </span>
          )}
          <button onClick={onTest} disabled={testing} className={BTN_GHOST} title="Test">
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Test
          </button>
          <button onClick={onEdit} className={BTN_GHOST}>Edit</button>
          <button onClick={onDelete} className="p-1.5 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors">
            <Trash2 className="h-4 w-4" />
          </button>
          <button onClick={onToggle} className="p-1.5 text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-primary)] rounded-lg transition-colors">
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-[var(--ff-border-light)] px-5 py-4">
          <h3 className="text-sm font-semibold text-[var(--ff-text-secondary)] mb-3">Delivery Log</h3>
          {!deliveries ? (
            <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-teal-500" /></div>
          ) : deliveries.length === 0 ? (
            <p className="text-sm text-[var(--ff-text-secondary)] py-2">No deliveries yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-[var(--ff-text-secondary)] border-b border-[var(--ff-border-light)]">
                    <th className="text-left py-2 pr-4">Date</th>
                    <th className="text-left py-2 pr-4">Event</th>
                    <th className="text-left py-2 pr-4">Status</th>
                    <th className="text-left py-2">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map(d => (
                    <tr key={d.id} className="border-b border-[var(--ff-border-light)] last:border-0">
                      <td className="py-2 pr-4 text-[var(--ff-text-secondary)] whitespace-nowrap">
                        {new Date(d.deliveredAt).toLocaleString('en-ZA')}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-[var(--ff-text-primary)]">{d.event}</td>
                      <td className="py-2 pr-4 text-[var(--ff-text-secondary)]">{d.responseStatus ?? '—'}</td>
                      <td className="py-2">
                        {d.success
                          ? <span className="flex items-center gap-1 text-green-400 text-xs"><CheckCircle className="h-3.5 w-3.5" /> OK</span>
                          : <span className="flex items-center gap-1 text-red-400 text-xs"><XCircle className="h-3.5 w-3.5" /> Failed</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
