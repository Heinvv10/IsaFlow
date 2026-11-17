/**
 * Email a final run's payslips (wave 6 PE), on the run page once its payslips are final.
 * Reads the two switches (GET /api/payroll/settings/payslip-email): while the platform switch is off it only says so;
 * an owner or admin turns the company setting on or off here (PUT, audited); with both on, "Email payslips" sends
 * each employee their own protected PDF (POST /api/payroll/runs/[id]/payslips/email) after a confirmation, and
 * lists who was sent, skipped (and why), failed, or may have been sent. The server sends a batch per request; the card
 * asks again until nothing remains. Below it, who has been emailed at this approval, with "Send again" for an owner
 * or admin. The protection is weak, and the card says so (spec §0a.18, review #1542 S7).
 */
import { useCallback, useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { PayslipEmailDeliveries } from './PayslipEmailDeliveries';
import {
  deliveriesOf, mergeOutcomes, notYetAttempted, outcomeOf, shouldContinue, stateOf, type Delivery, type EmailOutcome, type EmailState,
} from './payslipEmailPayloads';

/** Spec §0a.18 and review #1542 S7: said plainly, on the card and in the confirmation. */
export const WEAK_PROTECTION = 'Each PDF is protected with the employee\'s ID number, or passport number. This protection is weak '
  + '(40-bit RC4): anyone who knows the employee\'s ID number or date of birth can open it. It only keeps a payslip from a casual reader.';
const SKIP_LABEL: Record<string, string> = {
  NO_EMAIL: 'no email address on file', NO_ID_OR_PASSPORT: 'no ID or passport number to protect the PDF with',
  ALREADY_SENT: 'already sent (or may have been) for this approval',
  LAST_SEND_FAILED: 'the last send failed; check the address, then use Try again',
};
/** The server's batch (SEND_LIMITS.maxSends): a retry names at most this many employees per request. */
const RETRY_BATCH = 20;
/** A send loop stops after this many requests whatever the server says, so a fault can never spin. */
const MAX_ROUNDS = 50;

export function PayslipEmailCard({ runId, companyRole }: { runId: string; companyRole: string | null | undefined }) {
  const [state, setState] = useState<EmailState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<EmailOutcome | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const canSet = companyRole === 'owner' || companyRole === 'admin';
  const url = `/api/payroll/runs/${runId}/payslips/email`;

  const loadDeliveries = useCallback(async () => {
    try {
      setDeliveries(deliveriesOf(await apiJson(url, undefined, 'Could not load who was emailed')));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load who was emailed'));
    }
  }, [url]);

  const load = useCallback(async () => {
    try {
      setState(stateOf(await apiJson('/api/payroll/settings/payslip-email', undefined, 'Could not load the payslip email setting')));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the payslip email setting'));
    }
  }, []);
  useEffect(() => { void load(); void loadDeliveries(); }, [load, loadDeliveries]);

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

  /** POST until nothing remains (the server sends a batch per request), folding the answers; then re-read the list. */
  /**
   * POST round after round, folding the answers, until `nextBody` (given the last answer) says stop; then re-read the
   * list. MAX_ROUNDS backstops any fault.
   */
  async function rounds(nextBody: (last: EmailOutcome | null) => Record<string, unknown> | null): Promise<void> {
    setConfirming(false);
    setBusy(true);
    setError('');
    let total: EmailOutcome | null = null;
    let last: EmailOutcome | null = null;
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const body = nextBody(last);
        if (!body) break;
        last = outcomeOf(await apiJson(url, { method: 'POST', body: JSON.stringify(body) }, 'Could not email the payslips - try again'));
        total = total ? mergeOutcomes(total, last) : last;
        setOutcome(total);
      }
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not email the payslips - try again'));
    } finally {
      setBusy(false);
      void loadDeliveries();
    }
  }

  /** The same body until nothing remains or a round makes no progress (the server sends a batch per request). */
  function post(body: Record<string, unknown>): Promise<void> {
    let before = Number.POSITIVE_INFINITY;
    return rounds((last) => {
      if (last === null) return body;
      if (!shouldContinue(last, before)) return null;
      before = last.remaining;
      return body;
    });
  }

  /**
   * A plain send naming failed employees (no resend: nothing went out; review #1542 E-S1), a batch at a time. Each
   * round names only the ids this click has not attempted yet (F-A2): one the server just tried is never named again.
   */
  function retry(employeeIds: string[]): Promise<void> {
    let pending = employeeIds;
    return rounds((last) => {
      if (last !== null) {
        const next = notYetAttempted(pending, last);
        if (next.length === pending.length) return null; // no progress
        pending = next;
      }
      return pending.length === 0 ? null : { employeeIds: pending.slice(0, RETRY_BATCH) };
    });
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
          <p>Sent to {outcome.sent.length} {outcome.sent.length === 1 ? 'employee' : 'employees'}.{outcome.remaining > 0 ? ` ${outcome.remaining} still to send: press Email payslips again.` : ''}</p>
          {outcome.sent.filter((s) => s.addressChanged).map((s) => (
            <p key={`c-${s.employeeId}`} className="text-amber-700 dark:text-amber-400">
              Sent to a new address for {s.employeeName} ({s.employeeNumber}): it differs from where their last payslip went.
            </p>
          ))}
          {outcome.uncertain.map((u) => (
            <p key={`u-${u.employeeId}`} className="text-amber-700 dark:text-amber-400">
              May have been sent to {u.employeeName} ({u.employeeNumber}): the mail server did not confirm. It is not sent again unless an owner or admin chooses Send again.
            </p>
          ))}
          {outcome.skipped.map((s) => (
            <p key={`s-${s.employeeId}`} className="text-amber-700 dark:text-amber-400">
              Not sent to {s.employeeName} ({s.employeeNumber}): {SKIP_LABEL[s.reason] ?? s.reason}.
            </p>
          ))}
          {outcome.failed.map((f) => (
            <p key={`f-${f.employeeId}`} className="text-red-700 dark:text-red-400">Failed for {f.employeeName} ({f.employeeNumber}): {f.error}</p>
          ))}
        </div>
      )}
      {state?.platformEnabled && state.enabled && (
        <PayslipEmailDeliveries deliveries={deliveries} canResend={canSet} busy={busy}
          onRetry={(employeeIds) => void retry(employeeIds)}
          onResend={(employeeId) => void post({ employeeIds: [employeeId], resend: true })} />
      )}
      <Modal open={confirming} onClose={() => setConfirming(false)} title="Email payslips?" size="sm">
        <Modal.Body className="space-y-2 text-sm text-[var(--ff-text-primary)]">
          <p>Each employee with an email address and an ID or passport number is sent their own payslip.</p>
          <p className="text-[var(--ff-text-secondary)]">{WEAK_PROTECTION}</p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
          <Button onClick={() => void post({})}>Email payslips</Button>
        </Modal.Footer>
      </Modal>
    </section>
  );
}
