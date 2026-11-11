/**
 * The return lifecycle on the VAT201 and EMP201 pages (wave 5 L2): Finalised -> Filed (-> Amended -> v2 ...), who and
 * when for each step, the actions the role may take, and the warnings the server reports (lock removed outside the
 * lifecycle, the older vat_returns record disagreeing, drift since finalising). The server enforces every rule.
 */
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileCheck2, History, PencilLine } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { formatDate } from '@/utils/formatters';
import { ReturnActionDialog } from './ReturnActionDialog';
import { ReturnVersionsDrawer } from './ReturnVersionsDrawer';
import { availableActions, isImpersonating, lifecycleSteps, liveVersion, type LifecycleStep } from './returnLifecycleModel';
import { useReturnLifecycle } from './useReturnLifecycle';
import type { ReturnAction, ReturnForm } from './returnLifecycleClient';

interface Props { form: ReturnForm; periodStart: string; periodEnd: string; role: string | null }

const STEP_ICON: Record<LifecycleStep['kind'], typeof CheckCircle2> = { finalised: CheckCircle2, filed: FileCheck2, amended: PencilLine };

export function ReturnLifecycleBar({ form, periodStart, periodEnd, role }: Props) {
  const { data, loading, error, nameOf, reload } = useReturnLifecycle(form, periodStart, periodEnd);
  const [action, setAction] = useState<ReturnAction | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [done, setDone] = useState('');
  const [impersonating, setImpersonating] = useState(false);
  const versionsButton = useRef<HTMLButtonElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  /** The button that opened the dialog: focus goes back to it on close, or to the status line when it is gone. */
  const trigger = useRef<HTMLElement | null>(null);
  const open = (a: ReturnAction) => (e: { currentTarget: HTMLElement }) => { trigger.current = e.currentTarget; setDone(''); setAction(a); };
  const closeDialog = () => {
    setAction(null);
    requestAnimationFrame(() => (trigger.current?.isConnected ? trigger.current : statusLine.current)?.focus());
  };
  useEffect(() => { setImpersonating(isImpersonating()); }, []);
  // A new period is a new return: nothing from the last one stays open or announced.
  useEffect(() => { setAction(null); setDone(''); setDrawer(false); }, [form, periodStart, periodEnd]);

  const versions = data?.versions ?? [];
  const live = liveVersion(versions);
  const acts = availableActions(live, role, impersonating);
  const nextNo = versions.reduce((m, v) => Math.max(m, v.versionNo), 0) + 1;
  // The newest two versions' steps; the drawer holds the whole history.
  const steps = lifecycleSteps(versions).filter((s) => s.versionNo >= nextNo - 2);
  const earlier = nextNo - 3;
  // Status and actions only from a settled load: never "Not finalised" for a return that failed to load.
  const settled = data !== null && !loading && !error;
  const status = live ? (live.status === 'filed' ? `Filed (v${live.versionNo})` : `Finalised (v${live.versionNo}), not filed`)
    : versions.length > 0 ? `Amended: finalise v${nextNo}` : 'Not finalised';

  return (
    <section aria-labelledby="return-lifecycle-title" data-testid="return-lifecycle"
      className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id="return-lifecycle-title" className="text-sm font-semibold text-[var(--ff-text-primary)]">Return lifecycle</h2>
          <p ref={statusLine} tabIndex={-1} className="text-sm text-[var(--ff-text-secondary)] outline-none" data-testid="return-lifecycle-status">
            {settled ? status : loading ? 'Loading…' : 'Status unavailable'}
          </p>
        </div>
        {versions.length > 0 && (
          <Button ref={versionsButton} variant="secondary" size="sm" leftIcon={History} onClick={() => setDrawer(true)}>
            Versions ({versions.length})
          </Button>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-red-500 dark:text-red-400">{error}</p>}
      {done && <p role="status" className="text-sm text-teal-700 dark:text-teal-400">{done}</p>}

      {steps.length > 0 && (
        <ol className="flex flex-wrap gap-2" aria-label="Lifecycle steps">
          {steps.map((s) => {
            const Icon = STEP_ICON[s.kind];
            return (
              <li key={s.key} className="flex min-w-0 max-w-full items-start gap-1.5 rounded-md border border-[var(--ff-border-light)] px-2 py-1 text-xs">
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ff-text-secondary)]" aria-hidden="true" />
                <span className="min-w-0 break-words text-[var(--ff-text-secondary)]">
                  <span className="font-medium text-[var(--ff-text-primary)]">{s.label}</span>
                  {' '}by {nameOf(s.by)} on {formatDate(s.at)}
                  {s.detail && <>: {s.kind === 'filed' ? `reference ${s.detail}` : s.detail}</>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {earlier > 0 && (
        <p className="text-xs text-[var(--ff-text-secondary)]">
          {earlier} earlier version{earlier === 1 ? '' : 's'} in Versions.
        </p>
      )}

      {settled && live && (live.lockRemoved || live.drift?.drifted || data?.vatReturn?.mismatch) && (
        <div className="flex flex-wrap gap-2">
          {live.lockRemoved && <Badge variant="danger">VAT period lock removed outside the lifecycle</Badge>}
          {live.drift?.drifted && (
            <Badge variant="warning">
              {live.status === 'filed' ? 'Changed since filed: amend to file a correction' : 'Changed since finalised: amend before filing'}
            </Badge>
          )}
          {data?.vatReturn?.mismatch && <Badge variant="warning">Older VAT return record ({data.vatReturn.status}) differs</Badge>}
        </div>
      )}

      {settled && (acts.finalise || acts.file || acts.amend) && (
        <div className="flex flex-wrap gap-2">
          {acts.finalise && <Button size="sm" onClick={open('finalise')}>Finalise v{nextNo}</Button>}
          {acts.file && <Button size="sm" onClick={open('file')}>Mark filed</Button>}
          {acts.amend && <Button size="sm" variant="secondary" onClick={open('amend')}>Amend</Button>}
        </div>
      )}
      {settled && acts.note && <p className="text-xs text-[var(--ff-text-secondary)]" data-testid="return-lifecycle-note">{acts.note}</p>}

      {action && (
        <ReturnActionDialog key={action} form={form} action={action} periodStart={periodStart} periodEnd={periodEnd}
          version={action === 'finalise' ? null : live} nextVersionNo={nextNo}
          isOwnerOrAdmin={role === 'owner' || role === 'admin'}
          // A stale tab: the return moved on elsewhere. Reload it; the dialog then offers Amend (owner/admin) or Close.
          onStale={reload} canAmendInstead={acts.amend}
          onAmendInstead={() => setAction('amend')}
          onClose={closeDialog}
          onDone={(m) => { closeDialog(); setDone(m); void reload(); }} />
      )}
      <ReturnVersionsDrawer open={drawer} onClose={() => { setDrawer(false); versionsButton.current?.focus(); }} form={form} versions={versions}
        vatReturn={data?.vatReturn ?? null} nameOf={nameOf} />
    </section>
  );
}
