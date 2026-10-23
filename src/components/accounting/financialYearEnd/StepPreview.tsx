import type { YearEndChangeAssessment } from '@/modules/accounting/services/gl/financialYearEndChangeService';
import { BTN_PRIMARY, BTN_SECONDARY, CARD_CLS, MONTH_NAMES, fmtDay, monthOf } from './yearEndTypes';

interface Props {
  preview: YearEndChangeAssessment;
  onKind: (k: 'shorten' | 'extend') => void;
  onBack: () => void;
  onNext: () => void;
}

export function StepPreview({ preview, onKind, onBack, onNext }: Props) {
  const { chosen, options, refusals, effects, movingPeriods } = preview;
  const refused = refusals.length > 0 || chosen === null;
  return (
    <section className={CARD_CLS} data-testid="step-preview">
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">2. Preview the change</h2>

      {refusals.length > 0 && (
        <div role="alert" data-testid="preview-refusals" className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-400">
          <p className="font-semibold mb-1">This change cannot be made</p>
          <ul className="list-disc pl-5 space-y-1">{refusals.map(r => <li key={r}>{r}</li>)}</ul>
        </div>
      )}

      {options.length > 1 && (
        <fieldset className="mb-4" data-testid="preview-kind">
          <legend className="text-sm font-medium text-[var(--ff-text-secondary)] mb-2">This month allows a shorter or a longer transition year</legend>
          {options.map(o => (
            <label key={o.kind} className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)] mb-1">
              <input type="radio" name="kind" checked={chosen?.kind === o.kind} onChange={() => onKind(o.kind)} data-testid={`kind-${o.kind}`} />
              {o.kind === 'shorten' ? 'Shorten' : 'Extend'}: {o.months} months, ending {fmtDay(o.endDate)}
            </label>
          ))}
        </fieldset>
      )}

      {chosen && (
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-4">
          <div><dt className="text-[var(--ff-text-tertiary)]">Transition year</dt><dd data-testid="preview-range" className="font-medium text-[var(--ff-text-primary)]">{fmtDay(preview.currentYear.startDate)} to {fmtDay(chosen.endDate)}</dd></div>
          <div><dt className="text-[var(--ff-text-tertiary)]">Months</dt><dd data-testid="preview-months" className="font-medium text-[var(--ff-text-primary)]">{chosen.months}</dd></div>
          <div><dt className="text-[var(--ff-text-tertiary)]">Change</dt><dd className="font-medium text-[var(--ff-text-primary)] capitalize">{chosen.kind}</dd></div>
          <div><dt className="text-[var(--ff-text-tertiary)]">New year end</dt><dd className="font-medium text-[var(--ff-text-primary)]">{MONTH_NAMES[monthOf(chosen.endDate) - 1]}</dd></div>
        </dl>
      )}

      {movingPeriods.length > 0 && (
        <div className="mb-4" data-testid="preview-moving">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-2">Periods that change financial year</h3>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-[var(--ff-text-secondary)]"><th className="py-1">Period</th><th>Starts</th><th>Status</th><th className="text-right">Posted journals</th></tr></thead>
            <tbody>{movingPeriods.map(p => (
              <tr key={p.id} className="border-t border-[var(--ff-border-primary)] text-[var(--ff-text-primary)]">
                <td className="py-1">{p.periodName}</td><td>{fmtDay(p.startDate)}</td><td className="capitalize">{p.status}</td><td className="text-right">{p.postedJournals}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}

      {effects.length > 0 && (
        <div className="mb-4" data-testid="preview-effects">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-2">What this change does</h3>
          <ul className="list-disc pl-5 space-y-1 text-sm text-[var(--ff-text-secondary)]">{effects.map(e => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      <div className="flex gap-2 mt-6">
        <button type="button" className={BTN_SECONDARY} onClick={onBack}>Back</button>
        {!refused && <button type="button" data-testid="step-preview-next" className={BTN_PRIMARY} onClick={onNext}>Next</button>}
      </div>
    </section>
  );
}
