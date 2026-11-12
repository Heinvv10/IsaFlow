/**
 * TransferLinkNotice: tells the user that IsaFlow linked imported statement lines to existing transfers on its own
 * (opening Bank Transactions, or a statement import; migration 978), with Review, Undo and Dismiss, and a
 * "Transfer link log" link that stays after a dismiss. Hosts TransferLinkLogDrawer and owns its requests.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { canWrite } from '@/lib/auth/writeRoles';
import { notify } from '@/utils/toast';
import type { TransferLinkBatch } from '@/modules/accounting/services/bank/bankTransferLinkLog';
import { TransferLinkLogDrawer } from './TransferLinkLogDrawer';
import { readDismissed, writeDismissed } from './transferLinkDismissed';

const ROUTE = '/api/accounting/bank-transfer-links';
const LOAD_ERROR = 'Could not load the transfer link log - try again';
const UNDO_ERROR = 'Could not undo the transfer link - try again';
const NOTICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface UndoReply { undone: number; refused: number }

export function TransferLinkNotice({ bankAccountId, refreshKey, onChanged }: {
  bankAccountId: string; refreshKey: number; onChanged: () => void;
}) {
  const mayUndo = canWrite(useCompany().companyRole);
  const [batches, setBatches] = useState<TransferLinkBatch[]>([]);
  const [loadError, setLoadError] = useState('');
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!bankAccountId) { setBatches([]); return; }
    setLoadError('');
    try {
      const res = await apiFetch(`${ROUTE}?bankAccountId=${encodeURIComponent(bankAccountId)}`, { credentials: 'include' });
      await assertOk(res, LOAD_ERROR);
      const json = (await res.json()) as { data?: { batches?: TransferLinkBatch[] } } | null;
      setBatches(json?.data?.batches ?? []);
    } catch (err) {
      setBatches([]);
      setLoadError(apiErrorMessage(err, LOAD_ERROR));
    }
  }, [bankAccountId]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => { setDismissed(bankAccountId ? readDismissed(bankAccountId) : []); }, [bankAccountId]);

  const recent = Date.now() - NOTICE_WINDOW_MS;
  const noticeBatches = batches.filter(
    (b) => b.activeCount > 0 && Date.parse(b.linkedAt) >= recent && !dismissed.includes(b.batchId),
  );
  const count = noticeBatches.reduce((n, b) => n + b.activeCount, 0);

  /**
   * Undo each target in turn, carrying on past one the server refuses (its lines changed in another tab, say), so
   * one refused batch neither hides the batches already undone nor stops the ones after it. One toast for the lot.
   * `lines` is how many live links a target holds, counted as "not undone" when its request fails.
   */
  async function undo(targets: Array<({ batchId: string } | { linkId: string }) & { lines: number }>, busy: string) {
    setBusyId(busy);
    setUndoError(null);
    let undone = 0;
    let refused = 0;
    let firstError: string | null = null;
    for (const { lines, ...target } of targets) {
      try {
        const res = await apiFetch(ROUTE, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'undo', ...target }),
        });
        await assertOk(res, UNDO_ERROR);
        const data = ((await res.json()) as { data?: UndoReply } | null)?.data;
        undone += data?.undone ?? 0;
        refused += data?.refused ?? 0;
      } catch (err) {
        refused += lines;
        firstError ??= apiErrorMessage(err, UNDO_ERROR);
      }
    }
    if (firstError && undone === 0) {
      setUndoError(firstError);
      notify.error(firstError);
    } else if (refused > 0) {
      const detail = firstError ?? 'Those lines have changed since they were linked. Open each line to change it.';
      if (firstError) setUndoError(firstError);
      notify.warning(`${undone} undone, ${refused} not undone`, detail);
    } else {
      notify.success(undone === 1 ? '1 transfer link undone' : `${undone} transfer links undone`);
    }
    setBusyId(null);
    void load();
    if (undone > 0) onChanged();
  }

  function dismiss() {
    const next = [...dismissed, ...noticeBatches.map((b) => b.batchId)];
    setDismissed(writeDismissed(bankAccountId, next));
  }

  if (batches.length === 0 && !loadError) return null;

  const btn = 'rounded-md border border-[var(--ff-border-light)] px-2 py-1 text-xs font-medium text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-50';
  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        {loadError && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{loadError}</p>}
        {count > 0 && (
          <div role="status"
            className="flex-1 min-w-[16rem] rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-3">
            <p className="text-sm font-medium text-[var(--ff-text-primary)]">
              {count === 1 ? '1 transfer linked automatically.' : `${count} transfers linked automatically.`}
            </p>
            <p className="text-xs text-[var(--ff-text-secondary)]">
              IsaFlow matched imported statement lines to transfers already recorded on your other accounts.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={btn} onClick={() => setOpen(true)}>Review</button>
              {mayUndo && (
                <button type="button" className={btn} disabled={busyId !== null}
                  onClick={() => { void undo(noticeBatches.map((b) => ({ batchId: b.batchId, lines: b.activeCount })), 'notice'); }}>
                  {busyId === 'notice' ? 'Undoing...' : 'Undo'}
                </button>
              )}
              <button type="button" className={btn} onClick={dismiss}>Dismiss</button>
            </div>
          </div>
        )}
        {batches.length > 0 && (
          <button type="button" onClick={() => setOpen(true)}
            className="ml-auto text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline">
            Transfer link log
          </button>
        )}
      </div>
      <TransferLinkLogDrawer
        open={open} onClose={() => setOpen(false)} batches={batches} canUndo={mayUndo} busyId={busyId}
        error={undoError}
        onUndoBatch={(batchId) => {
          void undo([{ batchId, lines: batches.find((b) => b.batchId === batchId)?.activeCount ?? 0 }], batchId);
        }}
        onUndoLink={(linkId) => { void undo([{ linkId, lines: 1 }], linkId); }}
      />
    </>
  );
}
