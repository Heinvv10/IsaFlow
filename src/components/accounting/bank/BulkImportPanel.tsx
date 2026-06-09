import { useCallback, useMemo, useRef, useState, type DragEvent, type ChangeEvent } from 'react';
import { Upload, Loader2, CheckCircle2, AlertTriangle, FolderOpen } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import {
  collectFromDataTransfer,
  collectFromFileList,
  readFileForUpload,
  DEFAULT_BULK_LIMITS,
  type CollectedFile,
} from '@/lib/bulkUpload/folderTraversal';
import { runWithConcurrency } from '@/lib/bulkUpload/concurrencyQueue';
import { findCrossFileDuplicates } from '@/lib/bulkUpload/crossFileDedup';
import { BankAccountSelector, type BankAccountOption } from './BankAccountSelector';
import { BulkImportFileRow, type BulkImportRowState } from './BulkImportFileRow';
import type { BulkPreviewResponse, BulkCommitResponse } from './bulkImportTypes';

const PREVIEW_CONCURRENCY = 3;
const COMMIT_CONCURRENCY = 2;

function makeRowId(): string {
  return `r_${Math.random().toString(36).slice(2, 11)}`;
}

function clientUuid(): string {
  // RFC 4122 v4 — uses crypto.randomUUID where available, falls back otherwise.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: simple v4 generator (acceptable for grouping IDs).
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[(Math.random() * 4) | 8]!;
    else out += hex[Math.floor(Math.random() * 16)]!;
  }
  return out;
}

interface BulkSummary {
  bulkImportId: string;
  imported: number;
  skipped: number;
  failed: number;
  totalTransactions: number;
}

export function BulkImportPanel({ initialAccountId }: { initialAccountId?: string | null } = {}) {
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [bankAccount, setBankAccount] = useState<BankAccountOption | null>(null);
  const [rows, setRows] = useState<BulkImportRowState[]>([]);
  const collectedRef = useRef<Map<string, CollectedFile>>(new Map());
  const [isDragging, setIsDragging] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [applyBankRules, setApplyBankRules] = useState(true);
  const [summary, setSummary] = useState<BulkSummary | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ── Stats derived from rows ────────────────────────────────────────────────

  const stats = useMemo(() => {
    let ready = 0;
    let blocking = 0;
    let inFlight = 0;
    for (const r of rows) {
      if (r.phase === 'previewing' || r.phase === 'committing') inFlight++;
      else if (r.phase === 'previewed') {
        if (r.accountMatch === 'match' || r.accountMatch === 'inconclusive') ready++;
        else blocking++;
      }
    }
    const inconclusiveCount = rows.filter(
      r => r.phase === 'previewed' && r.accountMatch === 'inconclusive',
    ).length;
    return { ready, blocking, inFlight, inconclusiveCount };
  }, [rows]);

  const canCommit =
    !!bankAccountId &&
    !isCommitting &&
    stats.inFlight === 0 &&
    stats.blocking === 0 &&
    stats.ready > 0;

  // ── File ingestion ─────────────────────────────────────────────────────────

  const ingestCollected = useCallback(async (collected: CollectedFile[]) => {
    if (!bankAccountId) {
      notify.warning('Pick a bank account', 'Select the target bank account before adding files.');
      return;
    }
    if (collected.length === 0) return;

    const newRows: BulkImportRowState[] = collected.map(c => {
      const id = makeRowId();
      collectedRef.current.set(id, c);
      return {
        id,
        filename: c.file.name,
        relativePath: c.relativePath,
        sizeBytes: c.sizeBytes,
        phase: 'pending',
      };
    });

    setRows(prev => [...prev, ...newRows]);
    setSummary(null);

    // Mark in-flight then run previews with concurrency cap.
    setRows(prev => prev.map(r =>
      newRows.find(n => n.id === r.id) ? { ...r, phase: 'previewing' as const } : r,
    ));

    await runWithConcurrency(
      newRows,
      PREVIEW_CONCURRENCY,
      async (row) => {
        const collectedFile = collectedRef.current.get(row.id);
        if (!collectedFile) return;
        const filePayload = await readFileForUpload(collectedFile);
        const res = await apiFetch('/api/accounting/bank-transactions-bulk-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bankAccountId,
            filename: collectedFile.file.name,
            ...filePayload,
          }),
        });
        const json = await res.json();
        const data = (json?.data ?? json) as BulkPreviewResponse;
        applyPreview(row.id, data);
      },
      (_idx, settled) => {
        if (settled.status === 'rejected') {
          // worker already updates state per-row; keep noise low
          return;
        }
      },
    );

    // Cross-file dedupe pass (uses rowHashes returned by the previews).
    setRows(prev => annotateCrossFileDedup(prev));
  }, [bankAccountId]);

  function applyPreview(rowId: string, data: BulkPreviewResponse) {
    setRows(prev => prev.map(r => {
      if (r.id !== rowId) return r;
      return {
        ...r,
        phase: 'previewed',
        accountMatch: data.accountMatch,
        detectedBank: data.detectedBank,
        extractedAccountNumber: data.extractedAccountNumber,
        mismatchReason: data.mismatchReason,
        totalParsed: data.totalParsed,
        duplicatesVsDb: data.duplicatesVsDb,
        dateRange: data.dateRange,
        // Stash hashes on a non-rendered field via index by row id.
        ...(data.rowHashes ? { _rowHashes: data.rowHashes } as unknown as Partial<BulkImportRowState> : {}),
      };
    }));
    rowHashStore.set(rowId, data.rowHashes ?? []);
  }

  function annotateCrossFileDedup(currentRows: BulkImportRowState[]): BulkImportRowState[] {
    const previewed = currentRows.filter(r => r.phase === 'previewed' && rowHashStore.get(r.id));
    const dups = findCrossFileDuplicates(
      previewed.map(r => ({ filename: r.filename, rowHashes: rowHashStore.get(r.id) ?? [] })),
    );
    return currentRows.map(r => {
      const hit = dups.get(r.filename);
      if (!hit) return { ...r, duplicateOfFile: null, duplicateOfRows: undefined };
      return {
        ...r,
        duplicateOfFile: hit.duplicateOf,
        duplicateOfRows: hit.duplicateRows,
      };
    });
  }

  // ── Drag-drop handlers ─────────────────────────────────────────────────────

  const onDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const result = await collectFromDataTransfer(e.dataTransfer, DEFAULT_BULK_LIMITS);
    if (result.rejected.length > 0) {
      notify.warning(
        `${result.rejected.length} file(s) skipped`,
        result.rejected.slice(0, 3).map(r => `${r.name}: ${r.reason}`).join('\n'),
      );
    }
    void ingestCollected(result.files);
  }, [ingestCollected]);

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback(() => setIsDragging(false), []);

  const onPickFiles = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const result = collectFromFileList(files, DEFAULT_BULK_LIMITS);
    if (result.rejected.length > 0) {
      notify.warning(
        `${result.rejected.length} file(s) skipped`,
        result.rejected.slice(0, 3).map(r => `${r.name}: ${r.reason}`).join('\n'),
      );
    }
    void ingestCollected(result.files);
    e.target.value = '';
  }, [ingestCollected]);

  // ── Row actions ────────────────────────────────────────────────────────────

  const onRemoveRow = useCallback((id: string) => {
    collectedRef.current.delete(id);
    rowHashStore.delete(id);
    setRows(prev => annotateCrossFileDedup(prev.filter(r => r.id !== id)));
  }, []);

  const onRetryRow = useCallback(async (id: string) => {
    const collectedFile = collectedRef.current.get(id);
    if (!collectedFile || !bankAccountId) return;
    setRows(prev => prev.map(r => r.id === id ? { ...r, phase: 'previewing' } : r));
    try {
      const filePayload = await readFileForUpload(collectedFile);
      const res = await apiFetch('/api/accounting/bank-transactions-bulk-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bankAccountId,
          filename: collectedFile.file.name,
          ...filePayload,
        }),
      });
      const json = await res.json();
      applyPreview(id, (json?.data ?? json) as BulkPreviewResponse);
      setRows(prev => annotateCrossFileDedup(prev));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Retry failed';
      setRows(prev => prev.map(r => r.id === id ? {
        ...r, phase: 'previewed', accountMatch: 'parse_error', errorMessage: msg,
      } : r));
    }
  }, [bankAccountId]);

  // ── Commit ────────────────────────────────────────────────────────────────

  const onCommit = useCallback(async () => {
    if (!bankAccountId) return;
    const eligible = rows.filter(r =>
      r.phase === 'previewed' &&
      (r.accountMatch === 'match' || r.accountMatch === 'inconclusive'),
    );
    if (eligible.length === 0) return;

    const bulkImportId = clientUuid();
    setIsCommitting(true);
    setSummary(null);

    setRows(prev => prev.map(r =>
      eligible.find(e => e.id === r.id) ? { ...r, phase: 'committing' as const } : r,
    ));

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    let totalTransactions = 0;

    await runWithConcurrency(
      eligible.map((r, i) => ({ row: r, sequence: i + 1 })),
      COMMIT_CONCURRENCY,
      async ({ row, sequence }) => {
        const collectedFile = collectedRef.current.get(row.id);
        if (!collectedFile) {
          failed++;
          setRows(prev => prev.map(r => r.id === row.id ? {
            ...r, phase: 'failed', errorMessage: 'File data lost',
          } : r));
          return;
        }
        try {
          const filePayload = await readFileForUpload(collectedFile);
          const statementDate = row.dateRange?.to ?? new Date().toISOString().slice(0, 10);
          const res = await apiFetch('/api/accounting/bank-transactions-bulk-commit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              bankAccountId,
              bulkImportId,
              bulkSequence: sequence,
              filename: collectedFile.file.name,
              statementDate,
              sourceFileSizeBytes: collectedFile.sizeBytes,
              applyBankRules,
              ...filePayload,
            }),
          });
          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            const msg = errBody?.error?.message
              || errBody?.error
              || `Server returned ${res.status}`;
            failed++;
            setRows(prev => prev.map(r => r.id === row.id ? {
              ...r, phase: 'failed', errorMessage: String(msg),
            } : r));
            return;
          }
          const json = await res.json();
          const data = (json?.data ?? json) as BulkCommitResponse;
          if (data.status === 'imported') {
            imported++;
            totalTransactions += data.transactionCount ?? 0;
            setRows(prev => prev.map(r => r.id === row.id ? {
              ...r, phase: 'imported', importedTransactionCount: data.transactionCount ?? 0,
            } : r));
          } else if (data.status === 'skipped') {
            skipped++;
            setRows(prev => prev.map(r => r.id === row.id ? {
              ...r, phase: 'skipped',
            } : r));
          } else {
            failed++;
            setRows(prev => prev.map(r => r.id === row.id ? {
              ...r, phase: 'failed', errorMessage: data.reason ?? 'Unknown error',
            } : r));
          }
        } catch (err) {
          failed++;
          const msg = err instanceof Error ? err.message : 'Commit failed';
          setRows(prev => prev.map(r => r.id === row.id ? {
            ...r, phase: 'failed', errorMessage: msg,
          } : r));
        }
      },
    );

    setIsCommitting(false);
    setSummary({ bulkImportId, imported, skipped, failed, totalTransactions });

    if (failed === 0 && imported > 0) {
      notify.success(`Imported ${imported} statement${imported === 1 ? '' : 's'}`,
        `${totalTransactions} transactions added.`);
    } else if (imported > 0) {
      notify.warning(`Partial import`, `${imported} imported · ${failed} failed · ${skipped} skipped`);
    } else if (failed > 0) {
      notify.error('Import failed', `${failed} file(s) could not be imported.`);
    }
  }, [bankAccountId, rows, applyBankRules]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <BankAccountSelector
        value={bankAccountId}
        initialValue={initialAccountId}
        onChange={(id, opt) => { setBankAccountId(id); setBankAccount(opt); }}
        disabled={isCommitting || rows.length > 0}
        helpText={rows.length > 0
          ? 'Remove all files before changing the target account.'
          : 'All files in this bulk must belong to this account.'}
      />

      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          isDragging
            ? 'border-[var(--ff-accent)] bg-[var(--ff-accent)]/5'
            : 'border-[var(--ff-border)] bg-[var(--ff-bg-secondary)]'
        } ${!bankAccountId ? 'opacity-60' : ''}`}
      >
        <Upload className="mx-auto h-8 w-8 text-[var(--ff-text-muted)]" />
        <p className="mt-3 text-sm text-[var(--ff-text-primary)]">
          Drop a folder or files here, or
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            disabled={!bankAccountId || isCommitting}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--ff-accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            <FolderOpen className="h-4 w-4" />
            Choose folder
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!bankAccountId || isCommitting}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-tertiary)] px-4 py-2 text-sm font-medium text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)] disabled:opacity-50"
          >
            Choose files
          </button>
        </div>
        <p className="mt-3 text-xs text-[var(--ff-text-muted)]">
          PDF, CSV, OFX, QIF · up to {DEFAULT_BULK_LIMITS.maxFiles} files,
          {' '}{Math.round(DEFAULT_BULK_LIMITS.maxBytesPerFile / 1024 / 1024)} MB each,
          {' '}{Math.round(DEFAULT_BULK_LIMITS.maxTotalBytes / 1024 / 1024)} MB total
        </p>
        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onPickFiles}
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.csv,.ofx,.qfx,.qif"
          className="hidden"
          onChange={onPickFiles}
        />
      </div>

      {stats.inconclusiveCount > 0 && bankAccount && (
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-400">
          {stats.inconclusiveCount} file{stats.inconclusiveCount === 1 ? '' : 's'} have no
          {' '}embedded account number — they&apos;ll be imported into{' '}
          <span className="font-medium">{bankAccount.accountName}</span>.
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-[var(--ff-text-primary)]">
              {rows.length} file{rows.length === 1 ? '' : 's'} in queue
            </h3>
            <div className="flex items-center gap-3 text-xs text-[var(--ff-text-muted)]">
              <span>{stats.ready} ready</span>
              {stats.blocking > 0 && <span className="text-rose-500">{stats.blocking} blocking</span>}
              {stats.inFlight > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> {stats.inFlight} parsing
                </span>
              )}
            </div>
          </div>
          <ul className="space-y-1.5">
            {rows.map(row => (
              <BulkImportFileRow
                key={row.id}
                row={row}
                onRemove={onRemoveRow}
                onRetry={onRetryRow}
              />
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-secondary)] px-3 py-2.5">
        <label className="inline-flex max-w-xl items-start gap-2 text-sm text-[var(--ff-text-primary)]">
          <input
            type="checkbox"
            checked={applyBankRules}
            onChange={e => setApplyBankRules(e.target.checked)}
            disabled={isCommitting}
            className="mt-0.5 h-4 w-4 rounded border-[var(--ff-border)]"
          />
          <span>
            Run bank rules against the imported transactions
            <span className="mt-0.5 block text-xs text-[var(--ff-text-muted)]">
              Suggest-only rules attach a category. Auto-post rules also create
              and post a journal entry. Set per rule on the Rules page.
            </span>
          </span>
        </label>
        <button
          type="button"
          onClick={onCommit}
          disabled={!canCommit}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:bg-[var(--ff-bg-tertiary)] disabled:text-[var(--ff-text-muted)]"
        >
          {isCommitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {isCommitting
            ? 'Importing…'
            : stats.ready > 0
              ? `Import ${stats.ready} statement${stats.ready === 1 ? '' : 's'}`
              : 'Nothing to import'}
        </button>
      </div>

      {summary && (
        <div className="rounded-xl border border-[var(--ff-border)] bg-[var(--ff-bg-secondary)] p-4">
          <div className="flex items-center gap-3">
            {summary.failed === 0 ? (
              <CheckCircle2 className="h-6 w-6 text-emerald-500" />
            ) : (
              <AlertTriangle className="h-6 w-6 text-amber-500" />
            )}
            <div>
              <p className="text-base font-medium text-[var(--ff-text-primary)]">
                {summary.failed === 0 ? 'Bulk import complete' : 'Bulk import finished with issues'}
              </p>
              <p className="text-xs text-[var(--ff-text-muted)]">
                {summary.imported} imported · {summary.skipped} skipped · {summary.failed} failed
                {' · '}{summary.totalTransactions} transactions added
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// In-memory store keyed by row id for the rowHashes returned by previews.
// Avoids putting a large string[] into React state for every row.
const rowHashStore = new Map<string, string[]>();
