/**
 * The budget workspace page body (spec §4.4, §6.4): the year select and versions bar, the
 * toolbar, the grid and the save bar, plus the wizard, import, template and 409 dialogs. States:
 * loading (skeleton, bar disabled), load failed (message + Retry, the year select stays usable),
 * no version (WorkspaceEmptyState), no accounts (link to the chart), locked (read-only grid, no
 * save bar). Role from `useCompany().companyRole`; the server re-checks every write.
 */
import { useMemo, useState } from 'react';
import { Wallet } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';
import { useDensity } from '@/components/accounting/reportControls/useDensity';
import { yearOptionLabel } from '@/components/accounting/budgets/budgetClient';
import { BudgetGrid } from './BudgetGrid';
import { copyVersion } from './budgetWorkspaceClient';
import { CreateWizard } from './CreateWizard';
import { downloadDirtyCells } from './downloadDirtyCells';
import { GridToolbar } from './GridToolbar';
import { ImportDialog } from './ImportDialog';
import { SaveBar } from './SaveBar';
import { StaleVersionDialog, type StaleChoice } from './StaleVersionDialog';
import { TemplateDownloadDialog } from './TemplateDownloadDialog';
import { useBudgetGrid } from './useBudgetGrid';
import { useUnsavedGuard } from './useUnsavedGuard';
import { canWriteRole, VersionsBar } from './VersionsBar';
import { useBudgetYears, useWorkspaceVersions } from './useWorkspaceVersions';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';
import { failureText } from './failureText';
import type { SourceChoice } from './wizardDraft';

type Wizard = null | { source?: SourceChoice; fromVersion?: { id: string; fiscalYear: number } };

const PANEL = 'rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]';
const SELECT = 'min-w-0 max-w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)]';

function GridSkeleton() {
  return (
    <div className={`${PANEL} p-4`} data-testid="workspace-loading" aria-busy="true" aria-label="Loading the budget">
      <div className="mb-3 h-6 w-full animate-pulse rounded bg-[var(--ff-bg-tertiary)]" />
      {Array.from({ length: 8 }, (_, i) => <div key={i} className="mb-2 h-8 w-full animate-pulse rounded bg-[var(--ff-bg-tertiary)]" />)}
    </div>
  );
}

function ErrorPanel({ message, onRetry, busy }: { message: string; onRetry: () => void; busy: boolean }) {
  return (
    <div role="alert" data-testid="workspace-error" className={`${PANEL} flex flex-wrap items-center justify-between gap-2 p-4 text-sm text-[var(--ff-error-500)]`}>
      <span>{message}</span>
      <button type="button" onClick={onRetry} disabled={busy} className="rounded border border-[var(--ff-border-primary)] px-3 py-1 text-[var(--ff-text-primary)] disabled:opacity-50">Retry</button>
    </div>
  );
}

export function BudgetWorkspace() {
  const { companyRole } = useCompany();
  const canWrite = canWriteRole(companyRole);
  const years = useBudgetYears();
  const [chosenYear, setChosenYear] = useState<number | null>(null);
  const fiscalYear = chosenYear ?? years.initialYear;
  const grid = useBudgetGrid({ fiscalYear, canWrite });
  const versions = useWorkspaceVersions(fiscalYear, grid);
  const { density, setDensity } = useDensity();
  const [showPy, setShowPy] = useState(true);
  const [wizard, setWizard] = useState<Wizard>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  useUnsavedGuard(grid.dirtyCount);

  const { model, version, status } = grid;
  const locked = version?.status === 'locked';
  const editable = canWrite && version !== null && !locked;
  const loading = years.loading || status === 'loading' || status === 'idle';
  const compareLabel = versions.versions.find((v) => v.id === grid.compareVersionId)?.name ?? null;
  const yearOptions = years.years.length > 0 ? years.years : [];

  const labels = useMemo(() => {
    const accountLabels = new Map((model?.accounts ?? []).map((a) => [a.id, `${a.code} ${a.name}`]));
    const memberLabels = new Map(model ? [...model.dimensions.cc1, ...model.dimensions.cc2, ...model.dimensions.bu].map((m) => [m.id, `${m.code} ${m.name}`]) : []);
    return { accountLabels, memberLabels };
  }, [model]);

  const chooseStale = async (choice: StaleChoice): Promise<string | null> => {
    if (!model || !version || !grid.token) return 'The budget is not loaded.';
    if (choice === 'reapply') { await grid.reapplyMine(); return null; }
    if (choice === 'discard') { await grid.discardAndReload(); return null; }
    if (choice === 'download') {
      return downloadDirtyCells({
        versionId: version.id, versionName: version.name, fiscalYear: version.fiscalYear, token: grid.token,
        months: model.year.monthKeys, accounts: model.accounts, dimensions: model.dimensions,
        dirty: grid.store.dirtyMap().keys(), valueAt: (k) => grid.store.valueAt(k),
      });
    }
    // Locked: a draft copy of the version, my cells re-applied on top (unsaved, for review).
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const copy = await copyVersion(version.id, { name: `${version.name} (my changes ${stamp})`, kind: version.kind === 'original' ? 'reforecast' : version.kind });
    if (!copy.ok) return failureText(copy);
    await grid.reapplyMine(copy.data.id);
    versions.refresh();
    return null;
  };

  const onCreated = (versionId: string, opts: { thenImport: boolean }) => {
    setWizard(null);
    void grid.selectVersion(versionId).then(() => { versions.refresh(); if (opts.thenImport) setImportOpen(true); });
  };

  const focusSaveBar = () => document.querySelector<HTMLButtonElement>('[data-testid="save-bar"] button:last-of-type')?.focus();

  return (
    <div className="min-h-screen bg-[var(--ff-bg-primary)]">
      <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Wallet className="h-6 w-6 shrink-0 text-[var(--ff-brand)]" aria-hidden="true" />
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Budget workspace</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Financial year" data-testid="workspace-year" value={fiscalYear ?? ''} className={SELECT}
              disabled={years.loading || grid.dirtyCount > 0} onChange={(e) => setChosenYear(Number(e.target.value))}
              title={grid.dirtyCount > 0 ? 'Save or discard your changes first' : undefined}>
              {fiscalYear !== null && !yearOptions.some((y) => y.fiscalYear === fiscalYear) && <option value={fiscalYear}>{fiscalYear}</option>}
              {yearOptions.map((y) => <option key={y.fiscalYear} value={y.fiscalYear}>{yearOptionLabel(y)}</option>)}
            </select>
            <VersionsBar versions={versions.versions} current={version} role={companyRole} dirtyCount={grid.dirtyCount}
              disabled={loading} compareVersionId={grid.compareVersionId}
              onSelect={(id) => { void grid.selectVersion(id); }} onCompare={(id) => { void grid.setCompareVersion(id); }}
              onNewReforecast={() => { if (version) setWizard({ fromVersion: { id: version.id, fiscalYear: version.fiscalYear } }); }}
              onAction={versions.run} />
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-6">
        {years.error && <ErrorPanel message={years.error} onRetry={years.retry} busy={years.loading} />}
        {!years.error && status === 'error' && <ErrorPanel message={grid.error ?? 'Could not load the budget.'} onRetry={() => { void grid.reload(); }} busy={false} />}
        {(versions.listError || grid.compareError) && <p role="alert" className="text-sm text-[var(--ff-error-500)]">{versions.listError ?? grid.compareError}</p>}
        {!years.error && loading && status !== 'error' && <GridSkeleton />}
        {status === 'empty' && fiscalYear !== null && model && (
          <WorkspaceEmptyState fiscalYear={fiscalYear} noAccounts={model.accounts.length === 0} canWrite={canWrite}
            canCopy onStart={(source) => setWizard({ source })} />
        )}
        {status === 'ready' && model && version && model.accounts.length === 0 && (
          <WorkspaceEmptyState fiscalYear={version.fiscalYear} noAccounts canWrite={canWrite} canCopy={false} onStart={() => undefined} />
        )}
        {status === 'ready' && model && version && model.accounts.length > 0 && (
          <>
            <GridToolbar view={grid.view} dimensions={model.dimensions} members={grid.members} onViewChange={grid.setView}
              roundingUnit={grid.roundingUnit} onRoundingUnitChange={grid.setRoundingUnit} density={density} onDensityChange={setDensity}
              showPy={showPy} onShowPyChange={setShowPy} onDownloadTemplate={() => setTemplateOpen(true)}
              onImport={editable ? () => setImportOpen(true) : null} disabled={false} />
            {model.cells.length === 0 && editable && (
              <p className="text-sm text-[var(--ff-text-secondary)]" data-testid="workspace-no-amounts">
                This version has no amounts yet. Paste a block from Excel into the grid, type amounts, or use a row&apos;s actions to spread a total.
              </p>
            )}
            <BudgetGrid store={grid.store} view={grid.view} roundingUnit={grid.roundingUnit} density={density} showPy={showPy}
              compareLabel={compareLabel} canWrite={editable} members={grid.members}
              onSave={() => { void grid.save(); }} onExit={focusSaveBar} />
          </>
        )}
      </div>

      <SaveBar dirtyCount={grid.dirtyCount} saveState={grid.saveState} readOnly={!editable}
        onSave={() => { void grid.save(); }} onDiscard={grid.discard} />
      {grid.stale && <StaleVersionDialog stale={grid.stale} onChoose={chooseStale} onClose={grid.dismissStale} />}
      {wizard && fiscalYear !== null && (
        <CreateWizard open onClose={() => setWizard(null)} years={years.years} fiscalYear={fiscalYear}
          canMakePrimary={companyRole === 'owner' || companyRole === 'admin'} accounts={model?.accounts ?? []}
          currentTotals={version ? model?.totals.fy ?? null : null} sourceVersion={wizard.fromVersion ?? null}
          initialSource={wizard.source} onCreated={onCreated} />
      )}
      {importOpen && version && model && (
        <ImportDialog open onClose={() => setImportOpen(false)} versionId={version.id} months={model.year.monthKeys}
          accountLabels={labels.accountLabels} memberLabels={labels.memberLabels} dirtyCount={grid.dirtyCount}
          commitImport={grid.commitImport} onImported={() => { setImportOpen(false); versions.refresh(); }} />
      )}
      {templateOpen && version && model && (
        <TemplateDownloadDialog open onClose={() => setTemplateOpen(false)} versionId={version.id} fiscalYear={version.fiscalYear}
          dimensions={model.dimensions} cells={model.cells} />
      )}
    </div>
  );
}
