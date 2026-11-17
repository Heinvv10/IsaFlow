/**
 * Email a final run's payslips (wave 6 PE), on the run page once its payslips are final.
 * Reads the two switches (GET /api/payroll/settings/payslip-email): while the platform switch is off it only says so;
 * an owner or admin turns the company setting on or off here (PUT, audited); with both on, "Email payslips" sends
 * each employee their own protected PDF (POST /api/payroll/runs/[id]/payslips/email) after a confirmation, and
 * lists who was sent, skipped (and why) and failed. The protection is weak, and the card says so (spec §0a.18).
 */
import { useCallback, useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';

export const WEAK_PROTECTION = 'Each PDF is protected with the employee\'s ID number, or passport number. This protection is weak '
  + '(40-bit RC4): it keeps a payslip from a casual reader, not from someone set on opening it.';
const SKIP_LABEL: Record<string, string> = {
  NO_EMAIL: 'no email address on file', NO_ID_OR_PASSPORT: 'no ID or passport number to protect the PDF with',
  ALREADY_SENT: 'already sent for this approval',
};

interface State { platformEnabled: boolean; enabled: boolean }
interface Who { employeeNumber: string; employeeName: string }
interface Outcome { sent: Who[]; failed: Array<Who & { error: string }>; skipped: Array<Who & { reason: string }> }

/** The rows of one list whose `extra` field is text; anything else is dropped. */
function rows<K extends string>(u: unknown, extra?: K): Array<Who & Record<K, string>> {
  if (!Array.isArray(u)) return [];
  return u.flatMap((x: Record<string, unknown>) => {
    if (typeof x?.employeeNumber !== 'string' || typeof x?.employeeName !== 'string') return [];
    if (extra && typeof x[extra] !== 'string') return [];
    return [{ employeeNumber: x.employeeNumber, employeeName: x.employeeName, ...(extra ? { [extra]: x[extra] } : {}) } as Who & Record<K, string>];
  });
}
/** The routes' payloads, checked at run time (neither is in the apiRoutes registry). */
export function stateOf(d: unknown): State {
  const s = d as Partial<State> | null;
  if (typeof s?.platformEnabled !== 'boolean' || typeof s?.enabled !== 'boolean') throw new Error('Unexpected response');
  return { platformEnabled: s.platformEnabled, enabled: s.enabled };
}
export function outcomeOf(d: unknown): Outcome {
  const o = d as Record<string, unknown> | null;
  return { sent: rows(o?.sent), failed: rows(o?.failed, 'error'), skipped: rows(o?.skipped, 'reason') };
}

export function PayslipEmailCard({ runId, companyRole }: { runId: string; companyRole: string | null | undefined }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const canSet = companyRole === 'owner' || companyRole === 'admin';

  const load = useCallback(async () => {
    try {
      setState(stateOf(await apiJson('/api/payroll/settings/payslip-email', undefined, 'Could not load the payslip email setting')));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the payslip email setting'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(enabled: boolean): Promise<void> {
    setBusy(true);
    setToggling(true);
    setError('');
    try {
      setState(stateOf(await apiJson('/api/payroll/settings/payslip-email',
        { method: 'PUT', body: JSON.stringify({ enabled }) }, 'Could not change the payslip email setting')));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not change the payslip email setting'));
    } finally {
      setBusy(false);
      setToggling(false);
    }
  }

  async function send(): Promise<void> {
    setConfirming(false);
    setBusy(true);
    setError('');
    try {
      setOutcome(outcomeOf(await apiJson(`/api/payroll/runs/${runId}/payslips/email`,
        { method: 'POST', body: JSON.stringify({}) }, 'Could not email the payslips - try again')));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not email the payslips - try again'));
    } finally {
      setBusy(false);
    }
  }

  if (!state && !error) return null;
  return (
    <section aria-labelledby="payslip-email-heading" data-testid="payslip-email-card"
      className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="payslip-email-heading" className="flex items-center gap-2 text-sm font-semibold text-[var(--ff-text-primary)]">
          <Mail className="h-4 w-4 text-teal-600 dark:text-teal-400" aria-hidden="true" /> Email payslips
        </h2>
        {state?.platformEnabled && (
          <div className="flex flex-wrap gap-2">
            {canSet && (
              <Button size="sm" variant="secondary" loading={toggling} disabled={busy} onClick={() => void toggle(!state.enabled)}>
                {state.enabled ? 'Turn payslip email off' : 'Turn payslip email on'}
              </Button>
            )}
            {state.enabled && <Button size="sm" loading={busy && !toggling} disabled={busy} onClick={() => setConfirming(true)}>Email payslips</Button>}
          </div>
        )}
      </div>
      {state && !state.platformEnabled && (
        <p className="mt-2 text-sm text-[var(--ff-text-secondary)]">Emailing payslips is not switched on for IsaFlow yet.</p>
      )}
      {state?.platformEnabled && !state.enabled && (
        <p className="mt-2 text-sm text-[var(--ff-text-secondary)]">
          Payslip email is off for this company.{canSet ? '' : ' An owner or admin can turn it on.'}
        </p>
      )}
      {state?.platformEnabled && <p className="mt-2 text-xs text-[var(--ff-text-secondary)]">{WEAK_PROTECTION}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
      {outcome && (
        <div role="status" className="mt-3 space-y-1 text-sm text-[var(--ff-text-primary)]" data-testid="payslip-email-outcome">
          <p>Sent to {outcome.sent.length} {outcome.sent.length === 1 ? 'employee' : 'employees'}.</p>
          {outcome.skipped.map((s) => (
            <p key={`s-${s.employeeNumber}`} className="text-amber-700 dark:text-amber-400">
              Not sent to {s.employeeName} ({s.employeeNumber}): {SKIP_LABEL[s.reason] ?? s.reason}.
            </p>
          ))}
          {outcome.failed.map((f) => (
            <p key={`f-${f.employeeNumber}`} className="text-red-700 dark:text-red-400">Failed for {f.employeeName} ({f.employeeNumber}): {f.error}</p>
          ))}
        </div>
      )}
      <Modal open={confirming} onClose={() => setConfirming(false)} title="Email payslips?" size="sm">
        <Modal.Body className="space-y-2 text-sm text-[var(--ff-text-primary)]">
          <p>Each employee with an email address and an ID or passport number is sent their own payslip.</p>
          <p className="text-[var(--ff-text-secondary)]">{WEAK_PROTECTION}</p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
          <Button onClick={() => void send()}>Email payslips</Button>
        </Modal.Footer>
      </Modal>
    </section>
  );
}
