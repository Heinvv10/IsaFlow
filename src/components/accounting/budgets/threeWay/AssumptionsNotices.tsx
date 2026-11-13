/**
 * The Assumptions tab's notices for a stored document that no longer validates (400 BUDGET_ASSUMPTIONS_INVALID on
 * the read): its issues and "Replace with derived defaults", the banner while the replacement is in the form, and
 * the confirm before the save is retried over the stored row (budgets P6, PR C review note).
 */
import type { AssumptionsForm } from './useAssumptionsForm';

const BTN = 'inline-flex items-center rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)] disabled:opacity-50';
const AMBER = 'rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/60 dark:bg-amber-500/10 dark:text-amber-200';

export function InvalidDocNotice({ form, scenarioWithBase = false }: { form: AssumptionsForm; scenarioWithBase?: boolean }) {
  const d = form.invalidDoc;
  if (!d) return null;
  return (
    <div data-testid="assumptions-invalid" role="alert" className={`${AMBER} space-y-2`}>
      <p>{d.message}: the stored assumptions no longer pass the checks, so this version cannot be projected until they are replaced.</p>
      {d.issues.length > 0 && <ul className="list-disc pl-5 text-xs">{d.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
      {d.replaceError && <p className="text-error-700 dark:text-error-400">{d.replaceError}</p>}
      {form.readOnly ? <p>{form.readOnlyReason}</p> : !form.replacing && (scenarioWithBase ? (
        <>
          <p>This scenario will store no overrides of its own and follow its base version again.</p>
          <button type="button" className={BTN} disabled={form.saving || form.replaceToken !== null} onClick={() => void form.resetToBase()}>Reset to follow the base version</button>
        </>
      ) : (
        <button type="button" className={BTN} onClick={() => void form.replaceWithDerived()}>Replace with derived defaults</button>
      ))}
      {form.stale && !form.view && (
        <p>The stored document changed again. <button type="button" className={BTN} onClick={form.reload}>Reload</button></p>
      )}
      {form.replacing && <p>The form below holds the derived defaults. Review them and save to replace the stored document.</p>}
    </div>
  );
}

export function ReplaceConfirm({ form }: { form: AssumptionsForm }) {
  if (form.replaceToken === null) return null;
  return (
    <div data-testid="assumptions-replace-confirm" role="alert" className={`${AMBER} flex flex-wrap items-center gap-3`}>
      <span>A stored document exists for this version (the one that fails the checks). Replace it with what is in the form?</span>
      <button type="button" className={BTN} disabled={form.saving} onClick={() => void form.confirmReplace()}>Replace the stored document</button>
    </div>
  );
}
