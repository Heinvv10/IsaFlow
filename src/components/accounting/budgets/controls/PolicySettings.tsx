/**
 * The budget controls' company settings (budgets P5-4, decisions 8/9): the approval check policy
 * with a plain explanation of each, the default alert thresholds, and the email digest switch.
 * Owners and admins edit; a manager reads. The email switch is shown OFF and disabled with
 * "Email sending is switched off on this server" while the server's switch is unset (the server
 * refuses it too).
 */
import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { parseThresholds, type CheckPolicy, type ControlsView } from './controlsClient';

const PANEL = 'rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4';
const INPUT = 'w-full max-w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] disabled:opacity-60';
const BTN = 'inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';

export const POLICY_TEXT: Record<CheckPolicy, { label: string; help: string }> = {
  off: { label: 'Off', help: 'No budget check when a bill is approved.' },
  warn: {
    label: 'Warn',
    help: 'Approvals always go ahead. Someone approving a bill over budget in the app must type a reason, and it is recorded in the audit log. Bulk and automated approvals are recorded without a reason.',
  },
  block: {
    label: 'Block',
    help: 'A bill over budget is refused. An owner or admin can override a single approval by giving a reason; bulk and automated approvals cannot be overridden.',
  },
};

export interface PolicySettingsProps {
  view: ControlsView;
  canEdit: boolean;
  busy: boolean;
  onSave: (patch: { checkPolicy?: CheckPolicy; defaultThresholds?: number[]; alertEmailEnabled?: boolean }) => Promise<boolean>;
}

export function PolicySettings({ view, canEdit, busy, onSave }: PolicySettingsProps) {
  const { settings, emailAllowedOnServer } = view;
  const [policy, setPolicy] = useState<CheckPolicy>(settings.checkPolicy);
  const [thresholds, setThresholds] = useState(settings.defaultThresholds.join(', '));
  const [email, setEmail] = useState(settings.alertEmailEnabled);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    setPolicy(settings.checkPolicy);
    setThresholds(settings.defaultThresholds.join(', '));
    setEmail(settings.alertEmailEnabled);
  }, [settings]);

  const parsed = parseThresholds(thresholds);
  const dirty = policy !== settings.checkPolicy || email !== settings.alertEmailEnabled
    || (parsed.ok && parsed.values.join(',') !== settings.defaultThresholds.join(','));

  const submit = async () => {
    if (!parsed.ok) { setProblem(parsed.message); return; }
    setProblem('');
    await onSave({ checkPolicy: policy, defaultThresholds: parsed.values, alertEmailEnabled: email });
  };

  return (
    <section className={PANEL} aria-labelledby="budget-policy-heading" data-testid="budget-policy">
      <h2 id="budget-policy-heading" className="text-base font-semibold text-[var(--ff-text-primary)]">Approval check and alerts</h2>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor="budget-policy" className="block text-sm font-medium text-[var(--ff-text-primary)]">Budget check on bill approval</label>
          <select id="budget-policy" className={`${INPUT} mt-1`} value={policy} disabled={!canEdit || busy}
            onChange={(e) => setPolicy(e.target.value as CheckPolicy)}>
            {(Object.keys(POLICY_TEXT) as CheckPolicy[]).map((p) => <option key={p} value={p}>{POLICY_TEXT[p].label}</option>)}
          </select>
          <p className="mt-1 text-sm text-[var(--ff-text-secondary)]" data-testid="budget-policy-help">{POLICY_TEXT[policy].help}</p>
        </div>
        <div className="min-w-0">
          <label htmlFor="budget-thresholds" className="block text-sm font-medium text-[var(--ff-text-primary)]">Default alert thresholds (% of budget)</label>
          <input id="budget-thresholds" className={`${INPUT} mt-1`} value={thresholds} disabled={!canEdit || busy} inputMode="numeric"
            aria-describedby="budget-thresholds-help" onChange={(e) => setThresholds(e.target.value)} />
          <p id="budget-thresholds-help" className="mt-1 text-sm text-[var(--ff-text-secondary)]">
            Owners and admins get an alert in the bell when actual spend plus open purchase orders passes each of these percentages of an expense budget (up to 5, e.g. 80, 100, 120).
          </p>
        </div>
      </div>
      <div className="mt-4">
        <label className="inline-flex items-start gap-2 text-sm text-[var(--ff-text-primary)]">
          <input type="checkbox" className="mt-0.5" checked={emailAllowedOnServer && email}
            disabled={!canEdit || busy || !emailAllowedOnServer} onChange={(e) => setEmail(e.target.checked)} data-testid="budget-email-toggle" />
          <span>Also email owners and admins a daily digest of new alerts</span>
        </label>
        {!emailAllowedOnServer && (
          <p className="mt-1 text-sm text-[var(--ff-text-secondary)]" data-testid="budget-email-off">Email sending is switched off on this server.</p>
        )}
      </div>
      {problem && <p role="alert" className="mt-3 text-sm text-error-700 dark:text-error-400">{problem}</p>}
      {canEdit ? (
        <div className="mt-4">
          <button type="button" className={BTN} disabled={busy || !dirty} onClick={() => void submit()} data-testid="budget-settings-save">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />} Save
          </button>
        </div>
      ) : (
        <p className="mt-4 text-sm text-[var(--ff-text-secondary)]">Only an owner or admin can change these.</p>
      )}
    </section>
  );
}
