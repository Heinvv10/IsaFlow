/** One connection: who, what kind, whether it is live, what is still to set up, and this company's own settings. */
import { useState } from 'react';
import { Loader2, Link2 } from 'lucide-react';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import type { ConnectionView, SideOptions } from '@/modules/accounting/services/intercompany/connectionTypes';
import { ChecklistBadges } from './ChecklistBadges';
import { formatDisplayDate } from '@/utils/dateFormat';
import { PairSettingsForm } from './PairSettingsForm';
import { SideForm } from './SideForm';

interface Props {
  connection: ConnectionView;
  options: SideOptions;
  canEdit: boolean;
  onChanged: (updated: ConnectionView) => void;
  onNotice: (message: string, ok: boolean) => void;
}

type Panel = 'side' | 'pair';

const KIND_LABEL = { group: 'Group company', external: 'External company' } as const;
const STATUS_TONE = {
  active: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  pending: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30',
  revoked: 'bg-[var(--ff-bg-tertiary)] text-ink-muted border-[var(--ff-border-light)]',
} as const;

export function ConnectionCard({ connection, options, canEdit, onChanged, onNotice }: Props) {
  const [panel, setPanel] = useState<'side' | 'pair' | null>(null);
  const [revoking, setRevoking] = useState(false);
  const live = connection.status !== 'revoked';
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  const { settings } = connection;

  async function revoke() {
    if (!confirm(`End the connection with ${connection.partnerName}? Nothing new will be exchanged. Either company can later reconnect.`)) return;
    setRevoking(true);
    try {
      const updated = await apiJson(`/api/accounting/intercompany/connections/${connection.id}`, { method: 'DELETE' },
        'Could not revoke this connection - try again');
      onChanged(updated);
      onNotice('Connection revoked', true);
    } catch (err) {
      onNotice(apiErrorMessage(err, 'Could not revoke this connection - try again'), false);
    } finally {
      setRevoking(false);
    }
  }

  return (
    <section className="bg-[var(--ff-canvas-mid)] border border-[var(--ff-canvas-border)] rounded-xl p-5 space-y-4" data-testid="connection-card">
      <div className="flex flex-wrap items-center gap-3">
        <Link2 className="h-4 w-4 text-teal-500" aria-hidden />
        <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">{connection.partnerName}</h2>
        <span className="text-xs rounded-full border px-2 py-0.5 bg-[var(--ff-bg-tertiary)] text-ink-muted border-[var(--ff-border-light)]">
          {KIND_LABEL[connection.kind]}
        </span>
        <span data-testid="connection-status" className={`text-xs rounded-full border px-2 py-0.5 capitalize ${STATUS_TONE[connection.status]}`}>
          {connection.status}
        </span>
        <div className="ml-auto flex gap-2">
          {live && canEdit && (
            <>
              {connection.canEditSettings && (
                <button type="button" onClick={() => toggle('pair')} aria-expanded={panel === 'pair'}
                  className="px-3 py-1.5 text-sm rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]">
                  {panel === 'pair' ? 'Close' : 'Connection settings'}
                </button>
              )}
              <button type="button" onClick={() => toggle('side')} aria-expanded={panel === 'side'}
                className="px-3 py-1.5 text-sm rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]">
                {panel === 'side' ? 'Close' : 'My settings'}
              </button>
              <button type="button" onClick={() => void revoke()} disabled={revoking}
                className="px-3 py-1.5 text-sm rounded-lg text-red-600 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50 inline-flex items-center gap-2">
                {revoking && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                Revoke
              </button>
            </>
          )}
        </div>
      </div>
      {live && (
        <p className="text-xs text-ink-muted" data-testid="pair-summary">
          Settlement: {settings.settlementMode === 'loan' ? 'through an intercompany loan' : 'cash'}
          {' · '}Cut-over: {settings.cutoverDate ? formatDisplayDate(settings.cutoverDate) : 'not set'}
          {' · '}Interest: {settings.interestRatePct == null ? 'none' : `${settings.interestRatePct}% a year`}
        </p>
      )}
      {live && <ChecklistBadges checklist={connection.checklist} />}
      {live && panel === 'pair' && canEdit && connection.canEditSettings && (
        <PairSettingsForm connection={connection} onSaved={(c) => { onChanged(c); onNotice('Connection settings saved', true); }}
          onError={(m) => onNotice(m, false)} />
      )}
      {live && panel === 'side' && canEdit && (
        <SideForm connection={connection} options={options} onSaved={(c) => { onChanged(c); onNotice('Settings saved', true); }}
          onError={(m) => onNotice(m, false)} />
      )}
      {!live && <p className="text-xs text-ink-muted">This connection was revoked. Its settings are kept and return if it is reconnected.</p>}
    </section>
  );
}
