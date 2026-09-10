/**
 * AutoPostRunsPanel — shows recent confidence auto-post runs and allows bulk undo.
 * Hides itself when there are no active (not yet undone) runs with posted transactions.
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';

interface AutoPostRun {
  id: string;
  source: string;
  postedCount: number;
  totalAmount: number;
  createdAt: string;
  undoneAt: string | null;
}

interface AutoPostRunsResponse {
  data: {
    runs: AutoPostRun[];
  };
}

/** `undoRun`'s result. `undone` is false whenever a line was skipped. */
interface UndoResult {
  reversed: number;
  skipped: number;
  undone: boolean;
}

/**
 * What the user needs to know about a partial undo: the run stays listed, and
 * pressing Undo again changes nothing until the skipped lines are dealt with.
 */
function partialUndoMessage({ reversed, skipped }: UndoResult): string {
  return `Reversed ${reversed} line${reversed === 1 ? '' : 's'}; ${skipped} could not be undone `
    + 'because they are reconciled or still in use. Unreconcile those lines, then undo the run again.';
}

export function AutoPostRunsPanel({ onUndone }: { onUndone?: () => void }) {
  const [runs, setRuns] = useState<AutoPostRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [undoNotice, setUndoNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch('/api/accounting/bank-auto-post', { credentials: 'include' })
      .then((r) => r.json())
      .then((j: AutoPostRunsResponse) => setRuns(j?.data?.runs ?? []))
      .catch(() => setRuns([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function undo(runId: string) {
    setBusy(runId);
    setUndoError(null);
    setUndoNotice(null);
    try {
      const res = await apiFetch('/api/accounting/bank-auto-post', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undo', runId }),
      });
      if (res.status === 409) {
        throw new Error('Another request is working on this run\'s lines — try again in a moment.');
      }
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(errJson.error?.message ?? `Undo failed (${res.status})`);
      }
      const result = ((await res.json()) as { data?: UndoResult }).data;
      if (result?.undone === false) setUndoNotice(partialUndoMessage(result));
      load();
      onUndone?.();
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : 'Undo failed — please try again');
    } finally {
      setBusy(null);
    }
  }

  const active = runs.filter((r) => !r.undoneAt && r.postedCount > 0);
  if (active.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-3">
      <h3 className="text-xs font-semibold text-[var(--ff-text-secondary)] mb-2">Recent auto-post runs</h3>
      {undoError && (
        <p className="text-xs text-red-400 mb-2">{undoError}</p>
      )}
      {undoNotice && (
        <p role="status" className="text-xs text-amber-500 mb-2">{undoNotice}</p>
      )}
      <ul className="space-y-1">
        {active.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between text-sm text-[var(--ff-text-primary)]"
          >
            <span>
              Auto-posted {r.postedCount} (R{r.totalAmount.toLocaleString()}) · {r.source}
            </span>
            <button
              type="button"
              disabled={busy === r.id}
              onClick={() => { void undo(r.id); }}
              className="text-xs text-blue-500 hover:underline disabled:opacity-50"
            >
              {busy === r.id ? 'Undoing…' : 'Undo'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
