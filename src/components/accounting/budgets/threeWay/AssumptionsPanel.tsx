/**
 * The Assumptions tab (budgets P6 spec §4, §8, §13.18-21): the document grouped as §4, each scalar with its
 * Derived / Manual chip and derive evidence, the payable-account pickers, the lists, and Save with the row token.
 * 409 STALE shows a reload prompt (the edits stay until Reload); a locked version is read-only. A scenario over a
 * base saves its changes as overrides (`buildSaveDoc`).
 */
import { PROV_FIELDS, SECTION_TITLES, payableIssue, savesOverrides, type ProvSection } from './assumptionsModel';
import { PayablePicker, ProvFieldRow } from './AssumptionFields';
import { AssumptionLists } from './AssumptionLists';
import { useAssumptionsForm } from './useAssumptionsForm';
import { InvalidDocNotice, ReplaceConfirm } from './AssumptionsNotices';
import { warningText } from './warningText';

const BTN = 'inline-flex items-center rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)] disabled:opacity-50';
const PRIMARY = 'inline-flex items-center rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';
const CARD = 'rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4';
const SECTIONS: readonly ProvSection[] = ['workingCapital', 'vat', 'payroll', 'incomeTax', 'minimumCash'];

export interface AssumptionsPanelProps {
  versionId: string;
  /** The version is locked (the page knows its status first). */
  locked: boolean;
  /** The version's first month: new list entries start there. */
  firstMonth?: string;
  /** A save landed: re-run the three-way. */
  onSaved: () => void;
  /** A scenario over a base: an invalid stored document is reset to empty overrides, not replaced by derived defaults. */
  scenarioWithBase?: boolean;
}

export function AssumptionsPanel({ versionId, locked, firstMonth = '', onSaved, scenarioWithBase = false }: AssumptionsPanelProps) {
  const form = useAssumptionsForm(versionId, locked, onSaved, scenarioWithBase);
  const issues = form.saveError?.issues ?? [];
  const { view, edited } = form;
  if (form.loadError) return <p role="alert" className="text-sm text-error-700 dark:text-error-400">{form.loadError}</p>;
  if (form.invalidDoc && (!view || !edited)) {
    return <div className="space-y-3"><InvalidDocNotice form={form} scenarioWithBase={scenarioWithBase} /><ReplaceConfirm form={form} /></div>;
  }
  if (!view || !edited) return <p className="text-sm text-[var(--ff-text-secondary)]">Loading the assumptions…</p>;
  const derived = view.derived.assumptions;
  const ev = view.derived.evidence;
  return (
    <div className="space-y-4" key={form.generation} data-testid="assumptions-panel">
      <InvalidDocNotice form={form} scenarioWithBase={scenarioWithBase} />
      {view.warnings.map((w) => <p key={w.accountId} className="text-xs text-amber-800 dark:text-amber-300">{warningText(w)}</p>)}
      {form.readOnly && <p data-testid="assumptions-readonly" className="text-sm text-[var(--ff-text-secondary)]">{form.readOnlyReason}</p>}
      {form.stale && (
        <div data-testid="assumptions-stale" role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/60 dark:bg-amber-500/10 dark:text-amber-200">
          <span>These assumptions were changed since you opened them. Reload to see theirs; your edits here are not saved.</span>
          <button type="button" className={BTN} onClick={form.reload}>Reload</button>
        </div>
      )}
      <p className="text-xs text-[var(--ff-text-secondary)]">
        Derived from the books as at {ev.asAt}{ev.window.months > 0 ? `, ${ev.window.months} months of history (${ev.window.first} to ${ev.window.last})` : ''}.
        {ev.insufficientHistory ? ' Fewer than 3 months of history: the days are defaults.' : ''}
        {savesOverrides(view) ? ' This scenario saves only what you change; the rest follows its base.' : ''}
      </p>
      {SECTIONS.map((s) => (
        <section key={s} className={CARD} aria-labelledby={`tw-sec-${s}`}>
          <h3 id={`tw-sec-${s}`} className="mb-1 text-sm font-semibold text-[var(--ff-text-primary)]">{SECTION_TITLES[s]}</h3>
          <div className="divide-y divide-[var(--ff-border-light)]">
            {PROV_FIELDS.filter((f) => f.section === s).map((f) => (
              <ProvFieldRow key={f.path} field={f} doc={edited} derived={derived} readOnly={form.readOnly} onChange={form.update} />
            ))}
            {s === 'incomeTax' && (
              <PayablePicker label="Income tax payable account" value={edited.incomeTax.payableAccountId} accounts={form.accounts}
                evidence={ev.payableAccounts.incomeTaxPayable.basis} readOnly={form.readOnly} issue={payableIssue(issues, 'incomeTax')} testId="payable-issue-incomeTax"
                onChange={(id) => form.update((d) => ({ ...d, incomeTax: { ...d.incomeTax, payableAccountId: id } }))} />
            )}
          </div>
        </section>
      ))}
      <section className={CARD} aria-labelledby="tw-sec-lists">
        <h3 id="tw-sec-lists" className="mb-2 text-sm font-semibold text-[var(--ff-text-primary)]">Capex, loans and equity</h3>
        <PayablePicker label="Dividends payable account" value={edited.equity.dividendsPayableAccountId} accounts={form.accounts}
          evidence={ev.payableAccounts.dividendsPayable.basis} readOnly={form.readOnly} issue={payableIssue(issues, 'dividends')} testId="payable-issue-dividends"
          onChange={(id) => form.update((d) => ({ ...d, equity: { ...d.equity, dividendsPayableAccountId: id } }))} />
        <AssumptionLists doc={edited} firstMonth={firstMonth} loans={form.loans} readOnly={form.readOnly} onChange={form.update} />
      </section>
      <ReplaceConfirm form={form} />
      {form.saveError && (
        <div role="alert" className="text-sm text-error-700 dark:text-error-400">
          <p>{form.saveError.message}</p>
          {form.saveError.issues.length > 0 && <ul className="list-disc pl-5">{form.saveError.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
        </div>
      )}
      {!form.readOnly && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] py-3">
          <button type="button" className={PRIMARY} disabled={!form.dirty || form.saving || form.stale || form.replaceToken !== null} onClick={() => void form.save()}>
            {form.saving ? 'Saving…' : 'Save assumptions'}
          </button>
          <button type="button" className={BTN} disabled={!form.dirty || form.saving} onClick={form.discard}>Discard changes</button>
          {form.dirty && <span className="text-xs text-[var(--ff-text-secondary)]">Unsaved changes</span>}
        </div>
      )}
    </div>
  );
}
