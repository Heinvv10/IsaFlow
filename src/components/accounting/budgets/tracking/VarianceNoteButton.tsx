/**
 * A Budget vs Actual line's variance note (budgets P5 spec §3e, §5): an icon after the account name and a
 * dialog. Everyone sees the APPROVED note; owner/admin/manager also see a draft, labelled "Draft", or a
 * rejected one (`canReadSharingSurface`, the server's own rule: the list route sends a draft to nobody
 * else). Writers (owner/admin/manager) add or edit the draft; owner/admin approve or reject it. An approved
 * note is changed by an owner or admin only (saving withdraws the approval), so a manager is told so.
 * The server is the authority on every role: these only decide what to offer.
 */
import { useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { canReadSharingSurface } from '@/modules/accounting/services/reports/sharingAccess';
import {
  mayApproveVarianceNote, mayWriteVarianceNote, type VarianceNote, type VarianceSlice,
} from '@/modules/accounting/services/commentary/varianceNoteTypes';
import type { ActionResult } from './useVarianceNotes';

export interface VarianceNoteButtonProps {
  /** The line's name, for the button's accessible name and the dialog title. */
  label: string;
  slice: VarianceSlice;
  note: VarianceNote | undefined;
  role: string | null;
  onSave: (slice: VarianceSlice, text: string) => Promise<ActionResult>;
  onApprove: (id: string) => Promise<ActionResult>;
  onReject: (id: string) => Promise<ActionResult>;
}

const STATUS_LABEL = { draft: 'Draft', approved: 'Approved', rejected: 'Rejected' } as const;
const STATUS_COLOUR = {
  draft: 'text-amber-600 dark:text-amber-400',
  approved: 'text-[var(--ff-brand-500)]',
  rejected: 'text-[var(--ff-text-tertiary)]',
} as const;

export function VarianceNoteButton({ label, slice, note, role, onSave, onApprove, onReject }: VarianceNoteButtonProps) {
  const internal = canReadSharingSurface(role);
  const writer = mayWriteVarianceNote(role, slice);
  const approver = mayApproveVarianceNote(role);
  const visible = note !== undefined && (note.status === 'approved' || internal);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!visible && !writer) return null;

  const status = visible ? note.status : null;
  const editable = writer && (status !== 'approved' || approver);
  const openDialog = () => {
    setText(note ? (note.draftText ?? note.approvedText ?? '') : '');
    setProblem(null);
    setOpen(true);
  };
  const run = async (action: () => Promise<ActionResult>) => {
    setBusy(true);
    const reason = await action();
    setBusy(false);
    setProblem(reason);
    if (reason === null) setOpen(false);
  };
  const name = status ? `${STATUS_LABEL[status]} variance note on ${label}` : `Add a variance note on ${label}`;

  return (
    <>
      <button type="button" onClick={openDialog} aria-label={name} title={name}
        className={`inline-flex shrink-0 items-center rounded p-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ff-brand-500)] ${
          status ? STATUS_COLOUR[status] : 'text-[var(--ff-text-tertiary)] opacity-60 hover:opacity-100'}`}>
        <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Variance note: ${label}`} size="sm">
        <Modal.Body>
          <div className="space-y-3 text-sm text-[var(--ff-text-primary)]">
            {note?.status === 'approved' && note.approvedText !== null && (
              <section aria-label="Approved note">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ff-text-tertiary)]">Approved</p>
                <p className="whitespace-pre-wrap break-words">{note.approvedText}</p>
              </section>
            )}
            {internal && note && note.status !== 'approved' && note.draftText !== null && (
              <section aria-label={`${STATUS_LABEL[note.status]} note`}>
                <p className={`text-xs font-semibold uppercase tracking-wide ${STATUS_COLOUR[note.status]}`}>{STATUS_LABEL[note.status]}</p>
                <p className="whitespace-pre-wrap break-words">{note.draftText}</p>
              </section>
            )}
            {writer && status === 'approved' && !approver && (
              <p className="text-xs text-[var(--ff-text-secondary)]">An approved note can be changed by an owner or admin.</p>
            )}
            {editable && (
              <label className="block">
                <span className="text-xs text-[var(--ff-text-secondary)]">
                  {status === 'approved' ? 'Saving a new draft withdraws the approval until it is approved again.' : 'Your note (saved as a draft)'}
                </span>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={4000}
                  className="mt-1 w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] p-2 text-sm text-[var(--ff-text-primary)]" />
              </label>
            )}
            {problem && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{problem}</p>}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <div className="flex flex-wrap justify-end gap-2">
            {approver && note?.status === 'draft' && (
              <>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => onReject(note.id))}>Reject</Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => onApprove(note.id))}>Approve</Button>
              </>
            )}
            {editable && (
              <Button size="sm" disabled={busy || text.trim() === ''} onClick={() => void run(() => onSave(slice, text))}>Save draft</Button>
            )}
          </div>
        </Modal.Footer>
      </Modal>
    </>
  );
}
