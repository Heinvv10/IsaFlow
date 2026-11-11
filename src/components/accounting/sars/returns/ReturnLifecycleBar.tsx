/**
 * The return lifecycle on the VAT201 and EMP201 pages (wave 5 L2): Finalised -> Filed (-> Amended -> v2 ...), who and
 * when for each step, the actions the role may take, and the warnings the server reports (lock removed outside the
 * lifecycle, the older vat_returns record disagreeing, drift since finalising). The server enforces every rule.
 */
import { useEffect, useState } from 'react';
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
  useEffect(() => { setImpersonating(isImpersonating()); }, []);

  const versions = data?.versions ?? [];
  const live = liveVersion(versions);
  const acts = availableActions(live, role, impersonating);
  const steps = lifecycleSteps(versions);
  const nextNo = versions.reduce((m, v) => Math.max(m, v.versionNo), 0) + 1;
  const status = live ? (live.status === 'filed' ? `Filed (v${live.versionNo})` : `Finalised (v${live.versionNo}), not filed`)
    : versions.length > 0 ? `Amended: finalise v${nextNo}` : 'Not finalised';

  return (
    <section aria-labelledby="return-lifecycle-title" data-testid="return-lifecycle"
      className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id="return-lifecycle-title" className="text-sm font-semibold text-[var(--ff-text-primary)]">Return lifecycle</h2>
          <p className="text-sm text-[var(--ff-text-secondary)]" data-testid="return-lifecycle-status">{loading ? 'Loading…' : status}</p>
        </div>
        {versions.length > 0 && (
          <Button variant="secondary" size="sm" leftIcon={History} onClick={() => setDrawer(true)}>
            Versions ({versions.length})
          </Button>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-red-500 dark:text-red-400">{error}</p>}
      {done && <p role="status" className="text-sm text-teal-600 dark:text-teal-400">{done}</p>}

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

      {live && (live.lockRemoved || live.drift?.drifted || data?.vatReturn?.mismatch) && (
        <div className="flex flex-wrap gap-2">
          {live.lockRemoved && <Badge variant="danger">VAT period lock removed outside the lifecycle</Badge>}
          {live.drift?.drifted && <Badge variant="warning">Changed since finalised: amend before filing</Badge>}
          {data?.vatReturn?.mismatch && <Badge variant="warning">Older VAT return record ({data.vatReturn.status}) differs</Badge>}
        </div>
      )}

      {(acts.finalise || acts.file || acts.amend) && (
        <div className="flex flex-wrap gap-2">
          {acts.finalise && <Button size="sm" onClick={() => { setDone(''); setAction('finalise'); }}>Finalise v{nextNo}</Button>}
          {acts.file && <Button size="sm" onClick={() => { setDone(''); setAction('file'); }}>Mark filed</Button>}
          {acts.amend && <Button size="sm" variant="secondary" onClick={() => { setDone(''); setAction('amend'); }}>Amend</Button>}
        </div>
      )}
      {acts.note && <p className="text-xs text-[var(--ff-text-secondary)]" data-testid="return-lifecycle-note">{acts.note}</p>}

      {action && (
        <ReturnActionDialog form={form} action={action} periodStart={periodStart} periodEnd={periodEnd}
          version={action === 'finalise' ? null : live} versions={versions} nextVersionNo={nextNo}
          isOwnerOrAdmin={role === 'owner' || role === 'admin'}
          onClose={() => setAction(null)}
          onDone={(m) => { setAction(null); setDone(m); void reload(); }} />
      )}
      <ReturnVersionsDrawer open={drawer} onClose={() => setDrawer(false)} form={form} versions={versions}
        vatReturn={data?.vatReturn ?? null} nameOf={nameOf} />
    </section>
  );
}
