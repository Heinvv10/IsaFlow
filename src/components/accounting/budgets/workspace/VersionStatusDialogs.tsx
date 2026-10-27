/**
 * The versions bar's dialogs (spec §4.4, §10): confirm approve / lock / set primary, the unlock
 * reason (required, 1–500 characters once trimmed: P1's rule, checked again by the server), and
 * the delete confirm. Every dialog traps focus and hands it back to the button that opened it
 * (`useFocusTrap`), and stays open with the server's message when the action is refused.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useFocusTrap } from '@/components/ui/useFocusTrap';
import type { BudgetVersion } from './types';

export type VersionAction = 'approve' | 'lock' | 'unlock' | 'primary' | 'delete';

export interface VersionActionRequest {
  action: VersionAction;
  /** Unlock only: the trimmed reason. */
  reason?: string;
}

/** Resolves with null when the action succeeded, else the message to show in the dialog. */
export type RunVersionAction = (req: VersionActionRequest) => Promise<string | null>;

export const UNLOCK_REASON_MAX = 500;

/** The unlock reason as sent, or null when it is blank or longer than 500 characters once trimmed. */
export function validUnlockReason(text: string): string | null {
  const t = text.trim();
  return t.length >= 1 && t.length <= UNLOCK_REASON_MAX ? t : null;
}

const BTN = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50';
const BTN_SECONDARY = `${BTN} border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]`;
const BTN_PRIMARY = `${BTN} bg-[var(--ff-brand)] text-white hover:opacity-90`;
const BTN_DANGER = `${BTN} bg-[var(--ff-error-500)] text-white hover:opacity-90`;

interface ShellProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  testId?: string;
}

/** A focus-trapped dialog in the `--ff-*` theme; Escape and the backdrop close it. */
export function WorkspaceDialog({ title, onClose, children, footer, testId }: ShellProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose} role="presentation">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-6 shadow-2xl">
        <h2 id={titleId} className="mb-3 text-lg font-semibold text-[var(--ff-text-primary)]">{title}</h2>
        <div className="mb-6 space-y-3 text-sm text-[var(--ff-text-secondary)]">{children}</div>
        <div className="flex flex-wrap justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}

const COPY: Record<Exclude<VersionAction, 'unlock'>, { title: string; accept: string; body: (v: BudgetVersion) => string }> = {
  approve: {
    title: 'Approve version', accept: 'Approve',
    body: (v) => `Approve "${v.name}"? An approved version stays editable, and every save to it is audited.`,
  },
  lock: {
    title: 'Lock version', accept: 'Lock',
    body: (v) => `Lock "${v.name}"? Nobody can change its amounts until an owner unlocks it.`,
  },
  primary: {
    title: 'Set primary version', accept: 'Set primary',
    body: (v) => `Make "${v.name}" the primary budget for FY${v.fiscalYear}? Reports and budget-vs-actual read the primary version.`,
  },
  delete: {
    title: 'Delete version', accept: 'Delete',
    body: (v) => `Delete "${v.name}" and every amount in it (${v.amountCount} cells)? This cannot be undone.`,
  },
};

interface DialogsProps {
  /** The action waiting for confirmation; null renders nothing. */
  pending: VersionAction | null;
  version: BudgetVersion;
  onRun: RunVersionAction;
  onClose: () => void;
}

export function VersionStatusDialogs({ pending, version, onRun, onClose }: DialogsProps) {
  if (pending === null) return null;
  if (pending === 'unlock') return <UnlockReasonDialog version={version} onRun={onRun} onClose={onClose} />;
  return <ConfirmVersionDialog action={pending} version={version} onRun={onRun} onClose={onClose} />;
}

function useRunner(onRun: RunVersionAction, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (req: VersionActionRequest) => {
    setBusy(true);
    setError(null);
    let message: string | null;
    try {
      message = await onRun(req);
    } catch {
      message = 'Something went wrong. Try again.'; // onRun resolves its refusals; this is a crash
    } finally {
      setBusy(false);
    }
    if (message === null) onClose();
    else setError(message);
  };
  return { busy, error, run };
}

function ErrorLine({ error }: { error: string | null }) {
  if (error === null) return null;
  return <p role="alert" className="rounded-md bg-[var(--ff-bg-tertiary)] p-2 text-[var(--ff-error-500)]">{error}</p>;
}

function ConfirmVersionDialog({ action, version, onRun, onClose }: {
  action: Exclude<VersionAction, 'unlock'>; version: BudgetVersion; onRun: RunVersionAction; onClose: () => void;
}) {
  const { busy, error, run } = useRunner(onRun, onClose);
  const copy = COPY[action];
  return (
    <WorkspaceDialog title={copy.title} onClose={busy ? () => undefined : onClose} testId={`version-dialog-${action}`}
      footer={<>
        <button type="button" className={BTN_SECONDARY} onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className={action === 'delete' ? BTN_DANGER : BTN_PRIMARY} disabled={busy}
          onClick={() => { void run({ action }); }}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}{copy.accept}
        </button>
      </>}>
      <p>{copy.body(version)}</p>
      <ErrorLine error={error} />
    </WorkspaceDialog>
  );
}

function UnlockReasonDialog({ version, onRun, onClose }: { version: BudgetVersion; onRun: RunVersionAction; onClose: () => void }) {
  const { busy, error, run } = useRunner(onRun, onClose);
  const [text, setText] = useState('');
  const fieldId = useId();
  const reason = validUnlockReason(text);
  const length = text.trim().length;
  return (
    <WorkspaceDialog title="Unlock version" onClose={busy ? () => undefined : onClose} testId="version-dialog-unlock"
      footer={<>
        <button type="button" className={BTN_SECONDARY} onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className={BTN_PRIMARY} disabled={busy || reason === null}
          onClick={() => { if (reason !== null) void run({ action: 'unlock', reason }); }}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Unlock
        </button>
      </>}>
      <p>Unlock &quot;{version.name}&quot;? It becomes approved and editable again. The reason is kept in the audit log.</p>
      <label htmlFor={fieldId} className="block font-medium text-[var(--ff-text-primary)]">Reason (required)</label>
      <textarea id={fieldId} value={text} onChange={(e) => setText(e.target.value)} rows={3} disabled={busy}
        aria-describedby={`${fieldId}-count`} aria-invalid={text !== '' && reason === null}
        className="w-full rounded-md border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] p-2 text-[var(--ff-text-primary)]" />
      <p id={`${fieldId}-count`} className={length > UNLOCK_REASON_MAX ? 'text-[var(--ff-error-500)]' : ''}>
        {length} / {UNLOCK_REASON_MAX} characters
      </p>
      <ErrorLine error={error} />
    </WorkspaceDialog>
  );
}
