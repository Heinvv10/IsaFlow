/**
 * Finalise, Mark filed and Amend (wave 5 L2). Every refusal shows the server's own message, and the next step its
 * code names is offered here: the exceptions override (owner/admin, from the gate's counts), RATE_CHECK_FAILED (force),
 * VAT_RETURN_MISMATCH (a reason), LEGACY_SUBMISSION_EXISTS (the server's ids, with a reason) and LIVE_VERSION_EXISTS
 * (a stale tab: the bar reloads, then Amend or Close). The server judges all of it again.
 */
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiErrorMessage } from '@/lib/apiFetch';
import { VatGateOverrideBox } from '../VatGateOverrideBox';
import { ReturnReasonField } from './ReturnReasonField';
import { postReturnAction, type ReturnAction, type ReturnForm, type ReturnRefusalInfo, type ReturnVersionView } from './returnLifecycleClient';

interface Props {
  form: ReturnForm;
  action: ReturnAction;
  periodStart: string;
  periodEnd: string;
  /** The live version (file, amend) or null (finalise). */
  version: ReturnVersionView | null;
  nextVersionNo: number;
  isOwnerOrAdmin: boolean;
  /** Reload the lifecycle after a refusal that says it moved on elsewhere. */
  onStale: () => Promise<void>;
  /** Whether Amend is open to this person once the reload shows the live version. */
  canAmendInstead: boolean;
  onAmendInstead: () => void;
  onClose: () => void;
  onDone: (message: string) => void;
}

const has = (s: string) => s.trim() !== '';
/** The kit's 50% disabled fade fails contrast; a disabled button here is solid and muted instead. */
const DISABLED = 'disabled:opacity-100 disabled:bg-none disabled:bg-[var(--ff-bg-tertiary)] disabled:text-[var(--ff-text-secondary)] disabled:shadow-none';

function describe(form: ReturnForm, action: ReturnAction, n: number): { title: string; text: string; cta: string } {
  if (action === 'finalise') {
    return { title: `Finalise ${form} v${n}`, cta: 'Finalise',
      text: form === 'VAT201'
        ? `Locks the VAT period and records these figures as version ${n}. Postings into the period are refused until the return is amended.`
        : `Records these figures as version ${n}. Every pay run it sums must be approved.` };
  }
  if (action === 'file') {
    return { title: `Mark ${form} v${n} filed`, cta: 'Mark filed',
      text: 'Records that you filed this version on SARS eFiling. IsaFlow does not send the return to SARS: enter the reference eFiling gave you.' };
  }
  return { title: `Amend ${form} v${n}`, cta: 'Amend',
    text: `Version ${n} becomes superseded${form === 'VAT201' ? ' and its VAT period lock is released so postings can be corrected' : ''}. `
      + `Then finalise version ${n + 1} and file it.` };
}

export function ReturnActionDialog(p: Props) {
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [force, setForce] = useState(false);
  const [mismatchReason, setMismatchReason] = useState('');
  const [refusal, setRefusal] = useState<ReturnRefusalInfo | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  // Fixed at open: a stale-tab reload must not renumber the version this dialog was about.
  const [n] = useState(p.version?.versionNo ?? p.nextVersionNo);
  const { title, text, cta } = describe(p.form, p.action, n);

  const code = refusal?.code ?? null;
  const blocked = (refusal?.counts?.totalExceptions ?? 0) > 0;
  const offerForce = p.action === 'finalise' && (force || code === 'RATE_CHECK_FAILED');
  const offerMismatch = p.action === 'finalise' && (has(mismatchReason) || code === 'VAT_RETURN_MISMATCH');
  const [legacyIds, setLegacyIds] = useState<string[] | null>(null);
  const legacy = legacyIds !== null;
  const missing = (p.action === 'file' && !has(reference) && 'Enter the eFiling reference.')
    || (p.action === 'amend' && !has(reason) && 'A reason is required.')
    || (blocked && !p.isOwnerOrAdmin && 'Only an owner or admin can override the exceptions.')
    || (blocked && !has(overrideReason) && 'An override reason is required.')
    || (offerMismatch && !has(mismatchReason) && 'A reason is required.')
    || (legacy && !has(reason) && 'A reason is required.')
    || null;

  const body = (): Record<string, unknown> => {
    const override = blocked && has(overrideReason) ? { overrideReason: overrideReason.trim() } : {};
    if (p.action === 'finalise') {
      return { periodStart: p.periodStart, periodEnd: p.periodEnd, ...override, ...(force ? { force: true } : {}),
        ...(offerMismatch ? { acknowledgeVatReturnMismatch: true, mismatchReason: mismatchReason.trim() } : {}) };
    }
    if (p.action === 'file') {
      return { versionId: p.version?.id, reference, ...override, ...(legacy ? { correctsLegacySubmissionIds: legacyIds, reason } : {}) };
    }
    return { versionId: p.version?.id, reason };
  };

  const submit = async () => {
    setBusy(true);
    try {
      const out = await postReturnAction(p.form, p.action, body());
      if (out.ok) { p.onDone(`${title}: done.`); return; }
      setRefusal(out.refusal);
      // Legacy mode needs the server's ids: without them it is an ordinary refusal (the message alone), never an empty correction.
      const ids = out.refusal.legacySubmissionIds;
      if (out.refusal.code === 'LEGACY_SUBMISSION_EXISTS' && ids && ids.length > 0) setLegacyIds(ids);
      if (out.refusal.code === 'LIVE_VERSION_EXISTS') { setStale(true); await p.onStale(); }
    } catch (err) {
      setRefusal({ status: 0, message: apiErrorMessage(err, 'Could not reach the server - try again'), code: null, counts: null, legacySubmissionIds: null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={p.onClose} title={title} size="md" disableBackdropClose>
      <Modal.Body className="space-y-4">
        <p className="text-sm text-[var(--ff-text-secondary)]">{text}</p>
        {p.action === 'file' && !stale && (
          <Input label="SARS eFiling reference" value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} />
        )}
        {p.action === 'amend' && (
          <ReturnReasonField id="return-amend-reason" label="Reason for the amendment (required)" value={reason} onChange={setReason}
            hint="Kept on the version and in the audit trail." />
        )}
        {refusal && (
          <div role="alert" data-testid="return-refusal" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
            {refusal.message}
          </div>
        )}
        {blocked && (
          <VatGateOverrideBox counts={refusal?.counts ?? null} isOwnerOrAdmin={p.isOwnerOrAdmin}
            reason={overrideReason} onReasonChange={setOverrideReason} />
        )}
        {offerForce && (
          <label className="flex items-start gap-2 text-sm text-[var(--ff-text-primary)]">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="mt-0.5" />
            Finalise anyway and record that the period fails SARS&apos;s 15% check
          </label>
        )}
        {offerMismatch && (
          <ReturnReasonField id="return-mismatch-reason" label="Why finalise although the recorded VAT return differs (required)"
            value={mismatchReason} onChange={setMismatchReason} />
        )}
        {legacy && p.action === 'file' && (
          <ReturnReasonField id="return-legacy-reason"
            label={`Reason for superseding ${legacyIds.length} earlier filing${legacyIds.length === 1 ? '' : 's'} of this period (required)`}
            value={reason} onChange={setReason} />
        )}
        {!stale && missing && <p className="text-xs text-[var(--ff-text-secondary)]" data-testid="return-action-missing">{missing}</p>}
      </Modal.Body>
      <Modal.Footer>
        {stale ? (
          <>
            <Button variant="ghost" onClick={p.onClose}>Close</Button>
            {p.canAmendInstead && <Button variant="secondary" onClick={p.onAmendInstead}>Amend instead</Button>}
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={p.onClose}>Cancel</Button>
            <Button variant={p.action === 'amend' ? 'danger' : 'primary'} className={DISABLED} loading={busy}
              disabled={busy || missing !== null} onClick={() => void submit()}>
              {blocked && p.isOwnerOrAdmin ? `Override and ${cta.toLowerCase()}` : cta}
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}
