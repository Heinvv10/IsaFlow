/** Wizard step 2 (spec 8): where the new version's amounts come from. */
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/Input';
import type { BudgetYear } from '@/components/accounting/budgets/budgetClient';
import { listVersions } from './budgetWorkspaceClient';
import type { BudgetVersion } from './types';
import { parsePct, type SourceChoice, type WizardDraft } from './wizardDraft';
import { RadioOption, SelectField } from './wizardFields';

interface Props {
  draft: WizardDraft;
  years: readonly BudgetYear[];
  onChange: (patch: Partial<WizardDraft>) => void;
}

/** The versions of `fiscalYear`, loaded when it changes; null while loading. */
function useVersions(fiscalYear: number, enabled: boolean): { versions: BudgetVersion[] | null; error: string | null } {
  const [state, setState] = useState<{ fy: number; versions: BudgetVersion[] | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    void listVersions(fiscalYear).then((r) => {
      if (live) setState(r.ok ? { fy: fiscalYear, versions: r.data, error: null } : { fy: fiscalYear, versions: [], error: r.message });
    });
    return () => { live = false; };
  }, [fiscalYear, enabled]);
  return state?.fy === fiscalYear ? state : { versions: null, error: null };
}

const SOURCES: readonly { value: SourceChoice; label: string; hint?: string }[] = [
  { value: 'py_actuals', label: 'Prior-year actuals', hint: 'Posted actuals of the same calendar months a year earlier, plus a percentage.' },
  { value: 'version', label: 'Copy a version', hint: 'Any financial year. Another year is mapped month by month position.' },
  { value: 'blank', label: 'Blank', hint: 'An empty version to fill in the grid.' },
  { value: 'import', label: 'Import Excel', hint: 'Creates a blank version, then opens the import so you can upload a filled template.' },
];

export function WizardSourceStep({ draft, years, onChange }: Props) {
  const usesPct = draft.source === 'py_actuals' || draft.source === 'version';
  const { versions, error } = useVersions(draft.copyYear, draft.source === 'version');
  const pctBad = usesPct && parsePct(draft.upliftPct) === null;
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-[var(--ff-text-secondary)]">Start from</legend>
        {SOURCES.map((s) => (
          <RadioOption key={s.value} name="seed-source" value={s.value} checked={draft.source === s.value} label={s.label} hint={s.hint}
                       onChange={(v) => onChange({ source: v as SourceChoice })} />
        ))}
      </fieldset>
      {draft.source === 'version' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Copy from year" value={String(draft.copyYear)} onChange={(v) => onChange({ copyYear: Number(v), copyVersionId: '' })}>
            {years.map((y) => <option key={y.fiscalYear} value={y.fiscalYear}>{y.fiscalYear}</option>)}
          </SelectField>
          <SelectField label="Version to copy" value={draft.copyVersionId} disabled={versions === null} onChange={(v) => onChange({ copyVersionId: v })}>
            <option value="">{versions === null ? 'Loading…' : 'Pick a version'}</option>
            {(versions ?? []).map((v) => <option key={v.id} value={v.id}>{v.name} · {v.kind}</option>)}
          </SelectField>
          {error && <p role="alert" className="text-xs text-[var(--ff-unfav)] sm:col-span-2">{error}</p>}
        </div>
      )}
      {usesPct && (
        <Input label="Uplift (%)" inputMode="decimal" value={draft.upliftPct} onChange={(e) => onChange({ upliftPct: e.target.value })}
               error={pctBad ? 'A number from -100 to 1000.' : undefined} helperText="0 keeps the figures as they are." className="max-w-[10rem]" />
      )}
    </div>
  );
}
