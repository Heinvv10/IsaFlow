/**
 * The versions bar (spec §10): the FY's version switcher, the status chip, New reforecast,
 * Approve, Lock, Unlock, Set primary, Compare with and Delete. Which buttons render follows the
 * role × status matrix in `versionButtons`; the server is authoritative (P1's status, primary and
 * delete routes) and this gating is cosmetic. Every transition needs a clean grid. Below `md` the
 * action buttons collapse into one menu (§12); Approve and Lock stay reachable there.
 */
import { useState } from 'react';
import { Lock, Star } from 'lucide-react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { longDate } from '@/components/accounting/budgets/budgetClient';
import { VersionStatusDialogs, type RunVersionAction, type VersionAction } from './VersionStatusDialogs';
import type { BudgetVersion } from './types';

const MANAGE_ROLES = new Set(['owner', 'admin']);
const WRITE_ROLES = new Set(['owner', 'admin', 'manager']);

export const canWriteRole = (role: string | null): boolean => role !== null && WRITE_ROLES.has(role);

/** The status-changing buttons a role sees on a version (spec §10 table). */
export function versionButtons(v: BudgetVersion | null, role: string | null): ReadonlySet<VersionAction> {
  const out = new Set<VersionAction>();
  if (v === null || role === null) return out;
  const manage = MANAGE_ROLES.has(role);
  if (v.status === 'draft' && manage) out.add('approve');
  if (v.status === 'approved' && manage) out.add('lock');
  if (v.status === 'locked' && role === 'owner') out.add('unlock');
  if (!v.isPrimary && manage) out.add('primary');
  const deletable = v.status !== 'locked' && !v.isPrimary
    && ((v.status === 'draft' && canWriteRole(role)) || (v.status === 'approved' && manage));
  if (deletable) out.add('delete');
  return out;
}

const KIND_LABEL: Record<BudgetVersion['kind'], string> = { original: 'Original', reforecast: 'Reforecast', scenario: 'Scenario' };
const STATUS_LABEL: Record<BudgetVersion['status'], string> = { draft: 'Draft', approved: 'Approved', locked: 'Locked' };
const ACTION_LABEL: Record<VersionAction, string> = {
  approve: 'Approve', lock: 'Lock', unlock: 'Unlock', primary: 'Set primary', delete: 'Delete',
};
const ACTION_ORDER: readonly VersionAction[] = ['approve', 'lock', 'unlock', 'primary', 'delete'];

export const versionOptionLabel = (v: BudgetVersion): string =>
  `${v.name} · ${KIND_LABEL[v.kind]} · ${STATUS_LABEL[v.status]}${v.isPrimary ? ' ★' : ''}`;

function StatusChip({ version }: { version: BudgetVersion }) {
  const base = 'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium';
  if (version.status === 'locked') {
    const when = version.lockedAt ? ` on ${longDate(version.lockedAt)}` : '';
    return (
      <span data-testid="version-status-chip" title={`Locked${when}. Read-only until an owner unlocks it.`}
        className={`${base} border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)]`}>
        <Lock className="h-3 w-3" aria-hidden="true" />Locked{when}
      </span>
    );
  }
  const text = version.status === 'approved' ? 'Approved, edits are audited' : 'Draft';
  return <span data-testid="version-status-chip" className={`${base} border-[var(--ff-border-light)] text-[var(--ff-text-secondary)]`}>{text}</span>;
}

export interface VersionsBarProps {
  versions: readonly BudgetVersion[];
  current: BudgetVersion | null;
  role: string | null;
  /** Unsaved cells: every transition and a version switch wait for a clean grid. */
  dirtyCount: number;
  /** Loading, or another request in flight. */
  disabled: boolean;
  compareVersionId: string | null;
  onSelect: (versionId: string) => void;
  onCompare: (versionId: string | null) => void;
  onNewReforecast: () => void;
  onAction: RunVersionAction;
}

const BTN = 'inline-flex items-center gap-1.5 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)] disabled:opacity-50';
const SELECT = 'min-w-0 max-w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)]';

export function VersionsBar(props: VersionsBarProps) {
  const { versions, current, role, dirtyCount, disabled, compareVersionId, onSelect, onCompare, onNewReforecast, onAction } = props;
  const [pending, setPending] = useState<VersionAction | null>(null);
  const actions = ACTION_ORDER.filter((a) => versionButtons(current, role).has(a));
  const dirty = dirtyCount > 0;
  const blocked = disabled || dirty;
  const cleanNote = dirty ? `Save or discard ${dirtyCount} change${dirtyCount === 1 ? '' : 's'} first` : undefined;
  const others = versions.filter((v) => v.id !== current?.id);
  const reforecast = canWriteRole(role) && current !== null;

  const menuItems: ActionMenuItem[] = [
    ...(reforecast ? [{ label: 'New reforecast', onClick: onNewReforecast, disabled: blocked }] : []),
    ...actions.map((a) => ({
      label: ACTION_LABEL[a], onClick: () => setPending(a), disabled: blocked,
      tone: a === 'delete' ? 'destructive' as const : 'default' as const,
    })),
  ];

  return (
    <div data-testid="versions-bar" className="flex flex-wrap items-center gap-2">
      {current && (
        <>
          <select aria-label="Budget version" value={current.id} disabled={blocked} title={cleanNote}
            onChange={(e) => onSelect(e.target.value)} className={SELECT} data-testid="version-select">
            {versions.map((v) => <option key={v.id} value={v.id}>{versionOptionLabel(v)}</option>)}
          </select>
          {current.isPrimary && (
            <span className="inline-flex items-center gap-1 text-xs text-[var(--ff-text-secondary)]">
              <Star className="h-3 w-3" aria-hidden="true" />Primary
            </span>
          )}
          <StatusChip version={current} />
        </>
      )}
      <div className="hidden flex-wrap items-center gap-2 md:flex" data-testid="version-actions">
        {reforecast && (
          <button type="button" className={BTN} disabled={blocked} title={cleanNote} onClick={onNewReforecast}>New reforecast</button>
        )}
        {actions.map((a) => (
          <button key={a} type="button" className={BTN} disabled={blocked} title={cleanNote}
            onClick={() => setPending(a)} data-testid={`version-${a}`}>{ACTION_LABEL[a]}</button>
        ))}
      </div>
      {menuItems.length > 0 && (
        <div className="md:hidden"><ActionMenu items={menuItems} triggerLabel="Version actions" /></div>
      )}
      {current && others.length > 0 && (
        <select aria-label="Compare with" value={compareVersionId ?? ''} disabled={disabled} className={SELECT}
          onChange={(e) => onCompare(e.target.value === '' ? null : e.target.value)} data-testid="version-compare">
          <option value="">Compare with…</option>
          {others.map((v) => <option key={v.id} value={v.id}>{versionOptionLabel(v)}</option>)}
        </select>
      )}
      {cleanNote && <span className="text-xs text-[var(--ff-text-secondary)]" data-testid="versions-clean-note">{cleanNote}</span>}
      {current && (
        <VersionStatusDialogs pending={pending} version={current} onRun={onAction} onClose={() => setPending(null)} />
      )}
    </div>
  );
}
