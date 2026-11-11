/**
 * Finalise, Mark filed and Amend (wave 5 L2). Every refusal shows the server's own message; the next step it
 * names is offered here: the exceptions override (owner/admin, from the gate's counts), the 15% check force, the
 * vat_returns mismatch reason, and the legacy-filing correction (409 LEGACY_SUBMISSION_EXISTS). The server judges all of it.
 */
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiErrorMessage } from '@/lib/apiFetch';
import { VatGateOverrideBox } from '../VatGateOverrideBox';
import { ReturnReasonField } from './ReturnReasonField';
import {
  loadLegacySubmissionIds, postReturnAction, type ReturnAction, type ReturnForm, type ReturnRefusalInfo, type ReturnVersionView,
} from './returnLifecycleClient';

interface Props {
  form: ReturnForm;
  action: ReturnAction;
  periodStart: string;
  periodEnd: string;
  /** The live version (file, amend) or null (finalise). */
  version: ReturnVersionView | null;
  versions: ReturnVersionView[];
  nextVersionNo: number;
  isOwnerOrAdmin: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}

const has = (s: string) => s.trim() !== '';

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
  const [legacyIds, setLegacyIds] = useState<string[] | null>(null);
  const [refusal, setRefusal] = useState<ReturnRefusalInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const n = p.version?.versionNo ?? p.nextVersionNo;
  const { title, text, cta } = describe(p.form, p.action, n);

  const blocked = (refusal?.counts?.totalExceptions ?? 0) > 0;
  const offerForce = p.action === 'finalise' && (force || (refusal?.message.includes('15% check') ?? false));
  const offerMismatch = p.action === 'finalise' && (has(mismatchReason) || (refusal?.message.includes('acknowledgeVatReturnMismatch') ?? false));
  const legacy = legacyIds !== null;
  const ready = !busy
    && (p.action !== 'file' || has(reference))
    && (p.action !== 'amend' || has(reason))
    && (!blocked || (p.isOwnerOrAdmin && has(overrideReason)))
    && (!offerMismatch || has(mismatchReason))
    && (!legacy || has(reason));

  const body = (): Record<string, unknown> => {
    const override = blocked && has(overrideReason) ? { overrideReason: overrideReason.trim() } : {};
    if (p.action === 'finalise') {
      return { periodStart: p.periodStart, periodEnd: p.periodEnd, ...override, ...(force ? { force: true } : {}),
        ...(offerMismatch ? { acknowledgeVatReturnMismatch: true, mismatchReason: mismatchReason.trim() } : {}) };
    }
    if (p.action === 'file') {
      return { versionId: p.version?.id, reference, ...override,
        ...(legacy ? { correctsLegacySubmissionIds: legacyIds, reason } : {}) };
    }
    return { versionId: p.version?.id, reason };
  };

  const submit = async () => {
    setBusy(true);
    try {
      const out = await postReturnAction(p.form, p.action, body());
      if (out.ok) { p.onDone(`${title}: done.`); return; }
      setRefusal(out.refusal);
      if (out.refusal.code === 'LEGACY_SUBMISSION_EXISTS') {
        setLegacyIds(await loadLegacySubmissionIds(p.form, p.periodStart, p.periodEnd, p.versions));
      }
    } catch (err) {
      setRefusal({ status: 0, message: apiErrorMessage(err, 'Could not reach the server - try again'), code: null, counts: null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={p.onClose} title={title} size="md" disableBackdropClose>
      <Modal.Body className="space-y-4">
        <p className="text-sm text-[var(--ff-text-secondary)]">{text}</p>
        {p.action === 'file' && (
          <Input label="SARS eFiling reference" value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} />
        )}
        {p.action === 'amend' && (
          <ReturnReasonField id="return-amend-reason" label="Reason for the amendment (required)" value={reason} onChange={setReason}
            hint="Kept on the version and in the audit trail." />
        )}
        {refusal && (
          <div role="alert" data-testid="return-refusal" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-500 dark:text-red-400">
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
          <ReturnReasonField id="return-mismatch-reason" label="Why finalise although the older VAT return record differs (required)"
            value={mismatchReason} onChange={setMismatchReason} />
        )}
        {legacy && p.action === 'file' && (
          <ReturnReasonField id="return-legacy-reason"
            label={`Reason for superseding ${legacyIds.length} earlier filing${legacyIds.length === 1 ? '' : 's'} of this period (required)`}
            value={reason} onChange={setReason} />
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={p.onClose}>Cancel</Button>
        <Button variant={p.action === 'amend' ? 'danger' : 'primary'} loading={busy} disabled={!ready} onClick={() => void submit()}>
          {blocked && p.isOwnerOrAdmin ? `Override and ${cta.toLowerCase()}` : cta}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
