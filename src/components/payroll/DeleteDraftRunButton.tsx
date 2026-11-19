/**
 * Delete a draft pay run that was never calculated (wave 6 FQd; DELETE /api/payroll/runs/[id], payrollRunDelete).
 * A run made for the wrong week would otherwise hold its period. Confirmed first in the accessible Modal (focus taken on
 * open, Tab trapped, Escape closes, focus back on the button; review #1622 UI L3); on success, back to the runs list.
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';

export function DeleteDraftRunButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await assertOk(await apiFetch(`/api/payroll/runs/${runId}`, { method: 'DELETE' }), 'Could not delete the draft run - try again');
      setOpen(false);
      await router.push('/payroll/runs');
    } catch (err) {
      close();
      setError(apiErrorMessage(err, 'Could not delete the draft run - try again'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button ref={trigger} type="button" onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] text-sm font-medium">
        <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete draft
      </button>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      <Modal open={open} onClose={close} title="Delete this draft run?" size="sm" initialFocusRef={keep}>
        <Modal.Body>
          <p className="text-sm text-[var(--ff-text-secondary)]">It has paid nobody yet. Its period becomes free to create again.</p>
        </Modal.Body>
        <Modal.Footer>
          <Button ref={keep} variant="secondary" onClick={close}>Keep it</Button>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>Delete</Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}
