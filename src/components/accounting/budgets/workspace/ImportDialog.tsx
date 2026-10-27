/**
 * Excel import (spec 9.2): pick a .xlsx (refused client-side past 10 MB or when not .xlsx), preview
 * it (writes nothing), then commit the changed cells through the chained save with the preview's
 * token. A 409 mid-chain is reported as it is: earlier chunks were saved. The preview is re-run
 * from the kept file.
 */
import { useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import type { ImportPreview } from '@/modules/accounting/services/budgets/budgetImportDiff';
import type { SaveCell } from '@/modules/accounting/services/budgets/gridSaveValidate';
import { previewImport, type ChainResult } from './budgetWorkspaceClient';
import { failureText } from './failureText';
import { ImportDiffPreview, type ImportFailure } from './ImportDiffPreview';

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  versionId: string;
  months: readonly string[];
  accountLabels: ReadonlyMap<string, string>;
  memberLabels: ReadonlyMap<string, string>;
  /** Unsaved edits in the grid: an import is refused while there are any (the save would lose them). */
  dirtyCount: number;
  commitImport: (cells: SaveCell[], previewToken: string) => Promise<ChainResult>;
  /** The import was saved: the workspace reloads. */
  onImported: () => void;
}

/** Why `file` cannot be uploaded, or null. */
export function fileProblem(file: File): string | null {
  if (!/\.xlsx$/i.test(file.name)) return 'Choose an Excel .xlsx file (the template you downloaded).';
  if (file.size > MAX_IMPORT_BYTES) return 'That file is over 10 MB. Split it into smaller files or remove unused rows.';
  return null;
}

export function ImportDialog(p: ImportDialogProps) {
  const fileRef = useRef<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<ImportFailure | null>(null);

  const run = async (file: File) => {
    setBusy(true); setError(null); setFailure(null); setPreview(null);
    let r: Awaited<ReturnType<typeof previewImport>>;
    try { r = await previewImport(p.versionId, file); } finally { setBusy(false); }
    if (r.ok) setPreview(r.data); else setError(failureText(r));
  };
  const pick = (file: File | undefined) => {
    if (!file) return;
    const problem = fileProblem(file);
    if (problem) { fileRef.current = null; setError(problem); setPreview(null); return; }
    fileRef.current = file;
    void run(file);
  };
  const commit = async (cells: SaveCell[]) => {
    if (!preview) return;
    setBusy(true); setFailure(null);
    let r: ChainResult;
    try { r = await p.commitImport(cells, preview.updatedAt); } finally { setBusy(false); }
    if (r.ok) { p.onImported(); p.onClose(); return; }
    setFailure({ message: failureText(r.failure), failedChunk: r.failedChunk + 1, chunks: r.chunks });
  };

  return (
    <Modal open={p.open} onClose={p.onClose} title="Import from Excel" size="xl" disableBackdropClose={preview !== null}>
      <Modal.Body>
        <div className="space-y-3">
          <label className="flex flex-col gap-1 text-sm font-medium text-[var(--ff-text-secondary)]">
            Excel file (.xlsx, up to 10 MB)
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy}
                   onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {p.dirtyCount > 0 && (
            <p role="alert" className="text-sm text-[var(--ff-warning-500)]">
              You have {p.dirtyCount} unsaved edit{p.dirtyCount === 1 ? '' : 's'}. Save or discard them before you commit an import.
            </p>
          )}
          {busy && preview === null && <p className="text-sm text-[var(--ff-text-tertiary)]">Reading the file…</p>}
          {error && <p role="alert" className="text-sm text-[var(--ff-error-500)]">{error}</p>}
          {preview && (
            <ImportDiffPreview preview={preview} months={p.months} accountLabels={p.accountLabels} memberLabels={p.memberLabels}
                               nowMs={Date.now()} busy={busy || p.dirtyCount > 0} failure={failure}
                               onCommit={commit} onCancel={p.onClose}
                               onRerun={() => { if (fileRef.current) void run(fileRef.current); }} />
          )}
        </div>
      </Modal.Body>
    </Modal>
  );
}
