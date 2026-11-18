/**
 * Delete a draft pay run that was never calculated (wave 6 FQd; DELETE /api/payroll/runs/[id], payrollRunDelete).
 * A run made for the wrong week would otherwise hold its period. Confirmed first; on success, back to the runs list.
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';

export function DeleteDraftRunButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await assertOk(await apiFetch(`/api/payroll/runs/${runId}`, { method: 'DELETE' }), 'Could not delete the draft run - try again');
      setOpen(false);
      await router.push('/payroll/runs');
    } catch (err) {
      setOpen(false);
      setError(apiErrorMessage(err, 'Could not delete the draft run - try again'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 flex flex-col items-center gap-2">
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Delete draft</Button>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      <ConfirmDialog open={open} title="Delete this draft run?" tone="destructive" loading={busy}
        message="It has paid nobody yet. Its period becomes free to create again." acceptLabel="Delete" cancelLabel="Keep it"
        onAccept={() => void remove()} onCancel={() => setOpen(false)} />
    </div>
  );
}
