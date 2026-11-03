/**
 * /accounting/budgets/controls (budgets P5-4, spec §5): the company's budget check policy, alert
 * thresholds (default and per account or slice), the email digest switch, and, for owners and
 * admins, the overspend alerts with Evaluate now and "last evaluated". Write roles read the
 * settings; owners and admins change them; a viewer is told the page is not theirs. The server
 * re-checks every role.
 */
import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';
import { canWrite } from '@/lib/auth/writeRoles';
import { AlertsPanel } from './AlertsPanel';
import { PolicySettings } from './PolicySettings';
import { ThresholdOverrides } from './ThresholdOverrides';
import { useBudgetControls } from './useBudgetControls';

const PANEL = 'rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4';
const BTN = 'inline-flex items-center gap-1.5 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)]';

export function BudgetControlsPage() {
  const { companyRole, activeCompany } = useCompany();
  const known = companyRole !== null && activeCompany !== null;
  const canRead = canWrite(companyRole);
  const canAdmin = companyRole === 'owner' || companyRole === 'admin';
  const s = useBudgetControls(canAdmin, known && canRead);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-[var(--ff-text-primary)]">
            <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden /> Budget controls
          </h1>
          <p className="text-sm text-[var(--ff-text-secondary)]">How bill approvals are checked against the budget, and when you are alerted.</p>
        </div>
        <Link href="/accounting/budgets" className={BTN}>Back to budgets</Link>
      </div>

      {known && !canRead && (
        <p className={`${PANEL} text-sm text-[var(--ff-text-secondary)]`} data-testid="controls-forbidden">
          Budget controls are for owners, admins and managers.
        </p>
      )}
      {(!known || (canRead && s.loading && !s.view)) && (
        <div className={`${PANEL} h-40 animate-pulse`} aria-busy="true" aria-label="Loading the budget controls" />
      )}
      {s.loadError && (
        <div role="alert" className={`${PANEL} flex flex-wrap items-center justify-between gap-2 text-sm text-error-700 dark:text-error-400`}>
          {s.loadError}
          <button type="button" className={BTN} onClick={s.reload}>Retry</button>
        </div>
      )}
      {s.notice && (
        <p role={s.notice.tone === 'error' ? 'alert' : 'status'} data-testid="controls-notice"
          className={`text-sm ${s.notice.tone === 'error' ? 'text-error-700 dark:text-error-400' : 'text-[var(--ff-text-secondary)]'}`}>
          {s.notice.text}
        </p>
      )}
      {s.view && canRead && (
        <>
          <PolicySettings view={s.view} canEdit={canAdmin} busy={s.busy === 'settings'} onSave={s.save} />
          <ThresholdOverrides view={s.view} canEdit={canAdmin} busy={s.busy === 'override'} onAdd={s.addOverride} onRemove={s.removeOverride} />
          {canAdmin
            ? <AlertsPanel alerts={s.alerts} error={s.alertsError} busy={s.busy === 'evaluate'} onEvaluate={s.evaluate} />
            : <p className={`${PANEL} text-sm text-[var(--ff-text-secondary)]`}>Overspend alerts go to owners and admins.</p>}
        </>
      )}
    </div>
  );
}
