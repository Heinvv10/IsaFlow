/** Wizard step 3 (spec 8): grain, unassigned rule, rounding, and the Turnover / GP / NP preview. */
import { formatStatementFigure } from '@/lib/format/money';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import type { PriorGrain } from '@/modules/accounting/services/budgets/priorActuals';
import { PREVIEW_METRICS, type PreviewFigures } from './seedPreview';
import type { WizardPreview } from './useWizardPreview';
import type { Unassigned } from './seedPreview';
import type { WizardDraft } from './wizardDraft';
import { LABEL, RadioOption, SelectField } from './wizardFields';

const MAX_NAMED = 5;

interface Props {
  draft: WizardDraft;
  /** The year's current version figures (rand), or null when it has none. */
  current: PreviewFigures | null;
  preview: WizardPreview;
  onChange: (patch: Partial<WizardDraft>) => void;
  /** id -> "code name" for the rounding-flip notice. */
  accountLabels: ReadonlyMap<string, string>;
}

const GRAINS: readonly { value: PriorGrain; label: string }[] = [
  { value: 'company', label: 'Company (one row per account)' },
  { value: 'cc1', label: 'By cost centre 1' },
  { value: 'cc2', label: 'By cost centre 2' },
  { value: 'bu', label: 'By business unit' },
];
const UNITS: readonly RoundingUnit[] = [1, 100, 1000];

function FlipNotice({ ids, labels }: { ids: readonly string[]; labels: ReadonlyMap<string, string> }) {
  if (ids.length === 0) return null;
  const named = ids.slice(0, MAX_NAMED).map((id) => labels.get(id) ?? id);
  const more = ids.length - named.length;
  return (
    <p role="status" className="rounded border border-[var(--ff-border-light)] p-2 text-xs text-[var(--ff-text-primary)]">
      Rounding turns the last month of {named.join(', ')}{more > 0 ? ` and ${more} more` : ''} into the opposite sign to the account total; consider a smaller rounding unit.
    </p>
  );
}

function PreviewTable({ current, preview }: { current: PreviewFigures | null; preview: WizardPreview }) {
  const cell = (f: PreviewFigures | null | undefined, m: keyof PreviewFigures) => (f ? formatStatementFigure(f[m]) : '…');
  const next = preview.next && preview.next.ok ? preview.next.figures : null;
  return (
    <div className="space-y-1">
      <table className="w-full text-sm tabular-nums" style={{ fontFamily: 'var(--ff-fig-font, inherit)' }}>
        <thead>
          <tr className="text-xs text-[var(--ff-text-tertiary)]">
            <th scope="col" className="text-left font-normal">Full year</th>
            <th scope="col" className="text-right font-normal">Current</th><th scope="col" className="text-right font-normal">Prior year</th>
            <th scope="col" className="text-right font-normal">New version</th>
          </tr>
        </thead>
        <tbody>
          {PREVIEW_METRICS.map(({ metric, label }) => (
            <tr key={metric} data-metric={metric}>
              <th scope="row" className="text-left font-normal text-[var(--ff-text-secondary)]">{label}</th>
              <td className="text-right">{current ? formatStatementFigure(current[metric]) : '–'}</td>
              <td className="text-right">{cell(preview.prior, metric)}</td>
              <td className="text-right font-semibold">{cell(next, metric)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {preview.error && <p role="alert" className="text-xs text-[var(--ff-unfav)]">Could not load the figures: {preview.error}</p>}
      {preview.next && !preview.next.ok && <p role="alert" className="text-xs text-[var(--ff-unfav)]">{preview.next.reason}</p>}
    </div>
  );
}

export function WizardOptionsStep({ draft, current, preview, onChange, accountLabels }: Props) {
  const py = draft.source === 'py_actuals';
  return (
    <div className="space-y-4">
      {py && (
        <>
          <SelectField label="Seed at" value={draft.grain} onChange={(v) => onChange({ grain: v as PriorGrain })}>
            {GRAINS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </SelectField>
          {draft.grain !== 'company' && (
            <fieldset className="space-y-2">
              <legend className={LABEL}>Actuals with no {draft.grain === 'bu' ? 'business unit' : 'cost centre'} (Unassigned)</legend>
              <RadioOption name="unassigned" value="company" checked={draft.unassigned === 'company'} label="Keep them at company level"
                           hint="An account with any unassigned activity is budgeted at company level for the whole account."
                           onChange={(v) => onChange({ unassigned: v as Unassigned })} />
              <RadioOption name="unassigned" value="drop" checked={draft.unassigned === 'drop'} label="Drop them"
                           hint="Only the activity tagged to a member is seeded."
                           onChange={(v) => onChange({ unassigned: v as Unassigned })} />
            </fieldset>
          )}
        </>
      )}
      <SelectField label="Round each month to" value={String(draft.roundingUnit)} onChange={(v) => onChange({ roundingUnit: Number(v) as RoundingUnit })}>
        {UNITS.map((u) => <option key={u} value={u}>R{u}</option>)}
      </SelectField>
      {py && (
        <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
          <input type="checkbox" checked={draft.includeNoActivity} onChange={(e) => onChange({ includeNoActivity: e.target.checked })} />
          Include accounts with no prior-year activity (as zero rows)
        </label>
      )}
      <PreviewTable current={current} preview={preview} />
      {preview.next?.ok && <FlipNotice ids={preview.next.flips} labels={accountLabels} />}
    </div>
  );
}
