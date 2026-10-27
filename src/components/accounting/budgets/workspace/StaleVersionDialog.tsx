/**
 * The 409 dialog (spec §7.3). A save refused as STALE or LOCKED keeps every unsaved cell in the
 * store; this dialog says so and offers:
 * - stale: "Reload and re-apply mine" (fresh load + `rebaseDirty`; cells someone else changed
 *   are flagged as conflicts and my value is applied), "Discard mine and reload", and
 *   "Download my changes (.xlsx)";
 * - locked: "Copy into a new draft version" (copy of the version + my cells, committed as an
 *   import) instead of re-apply, plus the same discard and download.
 * Escape / "Keep editing" closes it and keeps the cells (the next save meets the 409 again).
 * A chained commit that stopped part-way says which chunk was refused (earlier chunks are saved).
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { WorkspaceDialog } from './VersionStatusDialogs';
import type { StaleState } from './types';

export type StaleChoice = 'reapply' | 'discard' | 'download' | 'copy';

/** budgetVersions.ts refuses a name over 120 characters once trimmed. */
export const VERSION_NAME_MAX = 120;

/** "<name> (my changes YYYY-MM-DD HH:MM)" in local time; the name is shortened (…) so the whole fits VERSION_NAME_MAX. */
export function myChangesName(name: string, at: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const suffix = ` (my changes ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())})`;
  const base = name.trim();
  const room = VERSION_NAME_MAX - suffix.length;
  return `${base.length <= room ? base : `${base.slice(0, room - 1).trimEnd()}…`}${suffix}`;
}

/** When the server says the version was last changed (the 409's token), in South African time. */
export function changedAt(stale: StaleState): string | null {
  if (!stale.currentUpdatedAt) return null;
  const at = new Date(stale.currentUpdatedAt);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Johannesburg' }).format(at);
}

export interface StaleVersionDialogProps {
  stale: StaleState;
  /** Runs one choice; resolves with null on success, else the message to show. */
  onChoose: (choice: StaleChoice) => Promise<string | null>;
  onClose: () => void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What happened to the version, in the spec's words. */
export function staleHeadline(stale: StaleState): string {
  if (stale.kind === 'locked' || stale.versionStatus === 'locked') return 'This budget was locked since you opened it.';
  if (stale.versionStatus === 'approved') return 'This budget was changed or approved since you opened it.';
  return 'This budget was changed since you opened it.';
}

const BTN = 'inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50';
const PRIMARY = `${BTN} bg-brand-600 text-white hover:bg-brand-700`;
const SECONDARY = `${BTN} border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)]`;

export function StaleVersionDialog({ stale, onChoose, onClose }: StaleVersionDialogProps) {
  const [busy, setBusy] = useState<StaleChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = stale.kind === 'locked' || stale.versionStatus === 'locked';

  const choose = async (choice: StaleChoice) => {
    setBusy(choice);
    setError(null);
    let message: string | null;
    try {
      message = await onChoose(choice);
    } catch {
      message = 'Something went wrong. Your changes are still here; try again.'; // onChoose resolves its refusals; this is a crash
    } finally {
      setBusy(null);
    }
    if (message !== null) setError(message);
  };
  const spin = (c: StaleChoice) => busy === c && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />;

  return (
    <WorkspaceDialog title={locked ? 'Budget locked' : 'Budget changed'} onClose={busy ? () => undefined : onClose}
      testId="stale-dialog"
      footer={<>
        <button type="button" className={SECONDARY} disabled={busy !== null} onClick={onClose}>Keep editing</button>
        <button type="button" className={SECONDARY} disabled={busy !== null} onClick={() => { void choose('download'); }}>
          {spin('download')}Download my changes (.xlsx)
        </button>
        <button type="button" className={SECONDARY} disabled={busy !== null} onClick={() => { void choose('discard'); }}>
          {spin('discard')}Discard mine and reload
        </button>
        {locked ? (
          <button type="button" className={PRIMARY} disabled={busy !== null} onClick={() => { void choose('copy'); }}>
            {spin('copy')}Copy into a new draft version
          </button>
        ) : (
          <button type="button" className={PRIMARY} disabled={busy !== null} onClick={() => { void choose('reapply'); }}>
            {spin('reapply')}Reload and re-apply mine
          </button>
        )}
      </>}>
      <p>{staleHeadline(stale)} Your {plural(stale.dirtyCount, 'unsaved change')} {stale.dirtyCount === 1 ? 'is' : 'are'} kept.</p>
      {changedAt(stale) && <p data-testid="stale-when">It was last changed at {changedAt(stale)}.</p>}
      {stale.chunks > 1 && (
        <p data-testid="stale-chunk">
          Part {stale.failedChunk + 1} of {stale.chunks} was refused. {stale.failedChunk === 0 ? 'Nothing was saved.'
            : stale.failedChunk === 1 ? 'Part 1 was saved.' : `Parts 1 to ${stale.failedChunk} were saved.`}
        </p>
      )}
      {!locked && <p>Re-applying loads the latest amounts and puts your changes on top. Cells someone else also changed are highlighted for you to check.</p>}
      {locked && <p>A locked version cannot be edited. Copy it into a new draft version with your changes, or download them.</p>}
      {error && <p role="alert" className="text-error-700 dark:text-error-400">{error}</p>}
    </WorkspaceDialog>
  );
}
