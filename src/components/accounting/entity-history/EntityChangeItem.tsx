/**
 * One recorded change: what (created / changed / deleted, and which entity in
 * the company-wide feed), who and how (the person, the channel — Login-as,
 * a token, the platform admin portal, a script), when, and each field's before
 * and after. Masked values (…1234) carry Reveal for owner / admin: the server
 * records every reveal in the audit log.
 */
import { useState } from 'react';
import { Eye, Lock } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import {
  CHANNEL_LABELS, ENTITY_TYPE_LABELS, type EntityChangeView,
} from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { CHANNEL_CLASSES, OP_CLASSES, OP_LABELS, fieldLabel, formatValue, sastDateTime } from './entityHistoryFormat';

interface Props {
  change: EntityChangeView;
  /** Owner / admin: may reveal masked values. */
  canReveal: boolean;
  /** The company-wide feed names the entity; a timeline does not need to. */
  showEntity?: boolean;
  onRevealed: (change: EntityChangeView) => void;
}

export function EntityChangeItem({ change, canReveal, showEntity = false, onRevealed }: Props) {
  const [revealing, setRevealing] = useState(false);
  const anyMasked = change.fields.some((f) => f.masked);
  // The company only says something when a row MOVED between companies.
  const fields = change.op === 'update' ? change.fields : change.fields.filter((f) => f.key !== 'company_id');
  const who = change.actorName ?? (change.actor.startsWith('db:') ? `Database (${change.actor.slice(3)})` : change.actor);

  const reveal = async () => {
    setRevealing(true);
    try {
      const res = await apiFetch('/api/accounting/entity-changes-reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changeId: change.id }),
      });
      await assertOk(res, 'Could not reveal this change - try again');
      const data = ((await res.json()) as { data?: EntityChangeView }).data;
      if (!data || !Array.isArray(data.fields)) throw new Error('Could not reveal this change - try again');
      onRevealed(data);
    } catch (err) {
      notify.error(apiErrorMessage(err, 'Could not reveal this change - try again'));
    } finally {
      setRevealing(false);
    }
  };

  return (
    <li className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-3 space-y-2" data-testid="entity-change">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${OP_CLASSES[change.op]}`}>{OP_LABELS[change.op]}</span>
        {showEntity && (
          <span className="text-[var(--ff-text-primary)] font-medium">
            {ENTITY_TYPE_LABELS[change.entityType]}{change.entityLabel ? `: ${change.entityLabel}` : ''}
          </span>
        )}
        <span className="text-[var(--ff-text-secondary)]">by <span className="text-[var(--ff-text-primary)]">{who}</span></span>
        <span className={`px-2 py-0.5 rounded text-xs ${CHANNEL_CLASSES[change.channel]}`}>
          {CHANNEL_LABELS[change.channel]}{change.impersonator ? ` by platform admin ${change.impersonator.slice(0, 8)}` : ''}
        </span>
        <span className="ml-auto text-xs text-[var(--ff-text-tertiary)]">{sastDateTime(change.recordedAt)}</span>
      </div>
      {fields.length > 0 && (
        <table className="w-full text-xs">
          <tbody>
            {fields.map((f) => (
              <tr key={f.key} className="border-t border-[var(--ff-border-light)] first:border-t-0">
                <td className="py-1 pr-3 text-[var(--ff-text-secondary)] w-1/3">
                  {fieldLabel(f.key)}{f.masked && <Lock className="inline h-3 w-3 ml-1 text-[var(--ff-text-tertiary)]" aria-label="masked" />}
                </td>
                {change.op !== 'create' && <td className="py-1 pr-3 text-[var(--ff-text-tertiary)] line-through break-all">{formatValue(f.before)}</td>}
                {change.op !== 'delete' && <td className="py-1 text-[var(--ff-text-primary)] break-all">{formatValue(f.after)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {anyMasked && canReveal && (
        <button type="button" onClick={() => { void reveal(); }} disabled={revealing}
          className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50">
          <Eye className="h-3.5 w-3.5" />{revealing ? 'Revealing…' : 'Reveal full numbers (recorded in the audit log)'}
        </button>
      )}
    </li>
  );
}
