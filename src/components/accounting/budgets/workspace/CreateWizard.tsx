/**
 * The create wizard (spec 8): a 3-step modal (Version, Source, Options) that creates a draft
 * budget version through `seedVersion` and hands the new id to the workspace. Also "New
 * reforecast" (pass `sourceVersionId`). Import Excel creates a blank version, then reports
 * `thenImport` so the workspace opens the import dialog on it.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { BUDGET_VERSION_KINDS, type BudgetVersionKind } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import type { BandTotals } from '@/modules/accounting/services/budgets/grid/subtotals';
import type { BudgetYear } from '@/components/accounting/budgets/budgetClient';
import { listVersions, seedVersion } from './budgetWorkspaceClient';
import type { PreviewAccount, PreviewFigures } from './seedPreview';
import { useWizardPreview } from './useWizardPreview';
import { buildSeedRequest, defaultDraft, stepError, type SourceChoice, type WizardDraft } from './wizardDraft';
import { SelectField } from './wizardFields';
import { WizardOptionsStep } from './WizardOptionsStep';
import { WizardSourceStep } from './WizardSourceStep';

export interface CreateWizardProps {
  open: boolean;
  onClose: () => void;
  /** Registry years the budget can be set for. */
  years: readonly BudgetYear[];
  /** The workspace's financial year: the wizard opens on it. */
  fiscalYear: number;
  /** Owner / admin only: "Make primary" is hidden for everyone else. */
  canMakePrimary: boolean;
  /** Revenue / expense accounts with their bands (the grid model's accounts). */
  accounts: readonly PreviewAccount[];
  /** The selected version's FY totals (rand), for the "Current" preview column. */
  currentTotals: BandTotals['fy'] | null;
  /** "New reforecast": start with a copy of this version. */
  sourceVersion?: { id: string; fiscalYear: number } | null;
  /** Preselect the source (the empty state's buttons); a `sourceVersion` wins with 'version'. */
  initialSource?: SourceChoice;
  /** The new version exists. `thenImport`: open the import dialog on it. */
  onCreated: (versionId: string, opts: { thenImport: boolean }) => void;
}

const STEPS = ['Version', 'Source', 'Options'] as const;
const KIND_LABEL: Record<BudgetVersionKind, string> = { original: 'Original', reforecast: 'Reforecast', scenario: 'Scenario' };

const initial = (p: CreateWizardProps): WizardDraft => ({
  ...defaultDraft({ fiscalYear: p.fiscalYear, hasVersions: Boolean(p.sourceVersion), copyVersionId: p.sourceVersion?.id, copyYear: p.sourceVersion?.fiscalYear }),
  ...(p.initialSource && !p.sourceVersion ? { source: p.initialSource } : {}),
});

export function CreateWizard(p: CreateWizardProps) {
  const [draft, setDraft] = useState<WizardDraft>(() => initial(p));
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [yearHasVersions, setYearHasVersions] = useState<boolean | null>(null);

  // Reset on open, so a second use never shows the last run.
  useEffect(() => {
    if (p.open) { setDraft(initial(p)); setStep(0); setError(null); setBusy(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when it opens
  }, [p.open]);

  // The kind follows whether the chosen year already has a version (the first is the original).
  useEffect(() => {
    if (!p.open) return undefined;
    let live = true;
    setYearHasVersions(null);
    void listVersions(draft.fiscalYear).then((r) => {
      if (!live) return;
      // A failed lookup must not lock the kind to 'original': assume versions exist and say so.
      const has = !r.ok || r.data.length > 0;
      if (!r.ok) setError(`Could not check the year's versions: ${r.message}`);
      setYearHasVersions(has);
      setDraft((d) => (d.fiscalYear !== draft.fiscalYear ? d : { ...d, kind: has ? (d.kind === 'original' ? 'reforecast' : d.kind) : 'original' }));
    });
    return () => { live = false; };
  }, [p.open, draft.fiscalYear]);

  const patch = (x: Partial<WizardDraft>) => { setDraft((d) => ({ ...d, ...x })); setError(null); };
  const preview = useWizardPreview(draft, p.years, p.accounts, p.open && step === 2);
  const firstVersion = yearHasVersions === false;
  const blocked = stepError(draft, step, firstVersion);
  const current: PreviewFigures | null = p.currentTotals && draft.fiscalYear === p.fiscalYear
    ? { turnover: p.currentTotals.turnover, grossProfit: p.currentTotals.grossProfit, netProfit: p.currentTotals.netProfit } : null;
  const canCreate = !busy && blocked === null && !(preview.next && !preview.next.ok) && yearHasVersions !== null;

  const create = async () => {
    setBusy(true);
    let r: Awaited<ReturnType<typeof seedVersion>>;
    try { r = await seedVersion(buildSeedRequest(draft)); } finally { setBusy(false); }
    if (!r.ok) { setError(r.message); return; }
    p.onClose();
    p.onCreated(r.data.versionId, { thenImport: draft.source === 'import' });
  };

  return (
    <Modal open={p.open} onClose={p.onClose} title="New budget version" size="lg" disableBackdropClose>
      <Modal.Body>
        <ol className="mb-4 flex gap-4 text-xs" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? 'step' : undefined}
                className={i === step ? 'font-semibold text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-tertiary)]'}>{i + 1}. {s}</li>
          ))}
        </ol>
        {step === 0 && (
          <div className="space-y-3">
            <SelectField label="Financial year" value={String(draft.fiscalYear)} onChange={(v) => patch({ fiscalYear: Number(v) })}>
              {p.years.map((y) => <option key={y.fiscalYear} value={y.fiscalYear}>{y.fiscalYear}</option>)}
            </SelectField>
            <Input label="Name" value={draft.name} maxLength={120} onChange={(e) => patch({ name: e.target.value })} />
            <SelectField label="Kind" value={draft.kind} disabled={firstVersion} onChange={(v) => patch({ kind: v as BudgetVersionKind })}>
              {BUDGET_VERSION_KINDS.filter((k) => (firstVersion ? k === 'original' : k !== 'original')).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </SelectField>
            {p.canMakePrimary && (
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                <input type="checkbox" checked={draft.makePrimary} onChange={(e) => patch({ makePrimary: e.target.checked })} />
                Make primary
              </label>
            )}
          </div>
        )}
        {step === 1 && <WizardSourceStep draft={draft} years={p.years} onChange={patch} />}
        {step === 2 && <WizardOptionsStep draft={draft} current={current} preview={preview} onChange={patch} />}
        {blocked && step < 2 && <p className="mt-3 text-xs text-[var(--ff-text-tertiary)]">{blocked}</p>}
        {error && <p role="alert" className="mt-3 text-sm text-[var(--ff-error-500)]">{error}</p>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={p.onClose}>Cancel</Button>
        {step > 0 && <Button variant="secondary" onClick={() => setStep(step - 1)}>Back</Button>}
        {step < 2
          ? <Button disabled={blocked !== null || yearHasVersions === null} onClick={() => setStep(step + 1)}>Next</Button>
          : <Button disabled={!canCreate} onClick={create}>{busy ? 'Creating…' : 'Create'}</Button>}
      </Modal.Footer>
    </Modal>
  );
}
