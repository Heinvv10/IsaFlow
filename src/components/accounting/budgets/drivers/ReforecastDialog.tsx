/**
 * "New reforecast from actuals" (P4 spec §1.3, §1.4, §7): pick the source version, name the new
 * draft reforecast, choose whether it rolls forward after each period close, then POST
 * `budget-versions/[source]/reforecast` `{ name, rolling }`. Closed months become the ledger's
 * actuals at each row's grain, open months keep the source's amounts, drivers recompute. The
 * result says what was made and lists the actuals it could not place (untagged actuals on an
 * account budgeted by a cost centre or business unit), by account; nothing is silently dropped.
 * P2's copy-based "New reforecast" stays beside this action.
 */
import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import { formatMoney } from '@/lib/money/formatMoney';
import { WorkspaceDialog } from '@/components/accounting/budgets/workspace/VersionStatusDialogs';
import { versionOptionLabel } from '@/components/accounting/budgets/workspace/VersionsBar';
import { failureText } from '@/components/accounting/budgets/workspace/failureText';
import type { ApiResult, BudgetVersion } from '@/components/accounting/budgets/workspace/types';
import type { ReforecastCreatedView, UnplacedActualLine } from './driverClient';

export const UNPLACED_COPY = 'Untagged actuals on accounts budgeted by cost centre cannot be placed';

export interface ReforecastDialogProps {
  versions: readonly BudgetVersion[];
  /** The version on screen: the default source. */
  current: BudgetVersion;
  create(sourceId: string, body: { name: string; rolling: boolean }): Promise<ApiResult<ReforecastCreatedView>>;
  /** The reforecast exists: open it (the dialog stays to show the result). */
  onCreated(version: BudgetVersion): void;
  onClose(): void;
}

const BTN = 'inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50';
const INPUT = 'w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)]';
const LEVEL: Record<UnplacedActualLine['level'], string> = { cc1: 'CC1', cc2: 'CC2', bu: 'BU' };

/** Unplaced actuals summed per account, with the months they fall in. */
export function unplacedByAccount(lines: readonly UnplacedActualLine[]) {
  const out = new Map<string, { label: string; level: string; months: string[]; amount: number }>();
  for (const u of lines) {
    const e = out.get(u.accountId) ?? { label: `${u.accountCode} ${u.accountName}`.trim(), level: LEVEL[u.level], months: [], amount: 0 };
    e.months.push(u.month);
    e.amount = Math.round((e.amount + u.amount) * 100) / 100;
    out.set(u.accountId, e);
  }
  return [...out.values()];
}

function Result({ data }: { data: ReforecastCreatedView }) {
  const rows = useMemo(() => unplacedByAccount(data.unplaced), [data.unplaced]);
  const closed = data.closedMonths;
  return (
    <div data-testid="reforecast-result" className="space-y-2">
      <p role="status">
        “{data.version.name}” was created as a draft{data.rolling ? ' that rolls forward after each close' : ''}:
        {' '}{closed.length === 0 ? 'no month is closed yet, so every month keeps the source amounts' : `${closed.length} closed month${closed.length === 1 ? '' : 's'} (${monthLabel(closed[0]!)} to ${monthLabel(closed[closed.length - 1]!)}) hold the actuals`}.
      </p>
      {data.warnings.map((w) => <p key={`${w.code}:${w.rowKey}`} className="text-[var(--ff-unfav)]">{w.message}</p>)}
      {rows.length > 0 && (
        <div data-testid="reforecast-unplaced">
          <p className="font-medium text-[var(--ff-text-primary)]">{UNPLACED_COPY}:</p>
          <ul className="mt-1 space-y-0.5">
            {rows.map((r) => (
              <li key={r.label}>{r.label} (budgeted by {r.level}): {formatMoney(r.amount)} in {r.months.map((m) => monthLabel(m)).join(', ')}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ReforecastDialog({ versions, current, create, onCreated, onClose }: ReforecastDialogProps) {
  const [sourceId, setSourceId] = useState(current.id);
  const [name, setName] = useState(`Reforecast from actuals: ${current.name}`.slice(0, 120));
  const [rolling, setRolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ReforecastCreatedView | null>(null);
  const trimmed = name.trim();

  const submit = async () => {
    if (trimmed.length < 1 || trimmed.length > 120) { setError('Name the reforecast (1 to 120 characters).'); return; }
    setBusy(true);
    const r = await create(sourceId, { name: trimmed, rolling });
    setBusy(false);
    if (!r.ok) { setError(failureText(r)); return; }
    setDone(r.data);
    onCreated(r.data.version);
  };

  const footer = done
    ? <button type="button" onClick={onClose} className={`${BTN} bg-brand-600 text-white hover:bg-brand-700`}>Close</button>
    : (
      <>
        <button type="button" onClick={onClose} className={`${BTN} border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)]`}>Cancel</button>
        <button type="button" onClick={() => { void submit(); }} disabled={busy} data-testid="reforecast-create" className={`${BTN} bg-brand-600 text-white hover:bg-brand-700`}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Create reforecast
        </button>
      </>
    );

  return (
    <WorkspaceDialog title="New reforecast from actuals" onClose={onClose} footer={footer} testId="reforecast-dialog">
      {done ? <Result data={done} /> : (
        <>
          <p>Closed months take the ledger&apos;s actuals at each row&apos;s level; open months keep the source&apos;s amounts; drivers recompute.</p>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Source version</span>
            <select className={INPUT} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {versions.map((v) => <option key={v.id} value={v.id}>{versionOptionLabel(v)}</option>)}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Name</span>
            <input className={INPUT} value={name} maxLength={120} onChange={(e) => { setName(e.target.value); setError(null); }} />
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={rolling} onChange={(e) => setRolling(e.target.checked)} />
            <span>Rolling: after each period close, closed months become actuals again and drivers recompute (one rolling forecast a year).</span>
          </label>
          {error && <p role="alert" className="text-error-700 dark:text-error-400">{error}</p>}
        </>
      )}
    </WorkspaceDialog>
  );
}
