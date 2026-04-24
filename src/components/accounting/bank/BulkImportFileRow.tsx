import {
  CheckCircle2, AlertCircle, AlertTriangle, Loader2, X, RotateCw,
  FileText, Calendar,
} from 'lucide-react';
import type { AccountMatchStatus } from './bulkImportTypes';

export type RowPhase =
  | 'pending'
  | 'previewing'
  | 'previewed'
  | 'committing'
  | 'imported'
  | 'skipped'
  | 'failed';

export interface BulkImportRowState {
  id: string;
  filename: string;
  relativePath: string;
  sizeBytes: number;
  phase: RowPhase;
  accountMatch?: AccountMatchStatus;
  detectedBank?: string | null;
  extractedAccountNumber?: string | null;
  mismatchReason?: string;
  totalParsed?: number;
  duplicatesVsDb?: number;
  duplicateOfFile?: string | null;
  duplicateOfRows?: number;
  dateRange?: { from: string; to: string } | null;
  errorMessage?: string;
  importedTransactionCount?: number;
}

interface BulkImportFileRowProps {
  row: BulkImportRowState;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  return iso.slice(0, 10).split('-').reverse().join('/');
}

function StatusPill({ row }: { row: BulkImportRowState }) {
  const phase = row.phase;

  if (phase === 'pending') {
    return <Pill icon={null} text="Queued" tone="muted" />;
  }
  if (phase === 'previewing') {
    return <Pill icon={<Loader2 className="h-3 w-3 animate-spin" />} text="Parsing…" tone="info" />;
  }
  if (phase === 'committing') {
    return <Pill icon={<Loader2 className="h-3 w-3 animate-spin" />} text="Importing…" tone="info" />;
  }
  if (phase === 'imported') {
    return <Pill icon={<CheckCircle2 className="h-3 w-3" />} text={`Imported ${row.importedTransactionCount ?? 0}`} tone="success" />;
  }
  if (phase === 'skipped') {
    return <Pill icon={<AlertTriangle className="h-3 w-3" />} text="All duplicates" tone="warn" />;
  }
  if (phase === 'failed') {
    return <Pill icon={<AlertCircle className="h-3 w-3" />} text="Failed" tone="danger" />;
  }
  // previewed → derive from accountMatch
  switch (row.accountMatch) {
    case 'match':
      return <Pill icon={<CheckCircle2 className="h-3 w-3" />} text="Ready" tone="success" />;
    case 'inconclusive':
      return <Pill icon={<CheckCircle2 className="h-3 w-3" />} text="No acct # — using selected" tone="info" />;
    case 'mismatch':
      return <Pill icon={<AlertCircle className="h-3 w-3" />} text="Wrong account" tone="danger" />;
    case 'parse_error':
      return <Pill icon={<AlertCircle className="h-3 w-3" />} text="Parse error" tone="danger" />;
    default:
      return <Pill icon={null} text="—" tone="muted" />;
  }
}

function Pill({ icon, text, tone }: {
  icon: React.ReactNode;
  text: string;
  tone: 'muted' | 'info' | 'success' | 'warn' | 'danger';
}) {
  const toneClass = {
    muted: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-muted)]',
    info: 'bg-sky-500/10 text-sky-500',
    success: 'bg-emerald-500/10 text-emerald-500',
    warn: 'bg-amber-500/10 text-amber-500',
    danger: 'bg-rose-500/10 text-rose-500',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${toneClass}`}>
      {icon}
      {text}
    </span>
  );
}

export function BulkImportFileRow({ row, onRemove, onRetry }: BulkImportFileRowProps) {
  const isTerminalSuccess = row.phase === 'imported' || row.phase === 'skipped';
  const showRemove = !isTerminalSuccess && row.phase !== 'previewing' && row.phase !== 'committing';
  const showRetry = row.phase === 'failed' || row.accountMatch === 'parse_error';

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-secondary)] px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <FileText className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ff-text-muted)]" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-[var(--ff-text-primary)]" title={row.relativePath}>
              {row.filename}
            </p>
            <p className="truncate text-xs text-[var(--ff-text-muted)]">
              {row.relativePath !== row.filename ? row.relativePath : null}
              {row.relativePath !== row.filename ? ' · ' : ''}
              {formatSize(row.sizeBytes)}
              {row.detectedBank ? ` · ${row.detectedBank.toUpperCase()}` : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <StatusPill row={row} />
          {showRetry && (
            <button
              type="button"
              onClick={() => onRetry(row.id)}
              className="rounded p-1 text-[var(--ff-text-muted)] hover:bg-[var(--ff-bg-tertiary)] hover:text-[var(--ff-text-primary)]"
              aria-label="Retry parse"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          )}
          {showRemove && (
            <button
              type="button"
              onClick={() => onRemove(row.id)}
              className="rounded p-1 text-[var(--ff-text-muted)] hover:bg-rose-500/10 hover:text-rose-500"
              aria-label="Remove file"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {(row.dateRange || row.totalParsed != null) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-6 text-xs text-[var(--ff-text-muted)]">
          {row.dateRange && (
            <span className="inline-flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {formatDate(row.dateRange.from)} → {formatDate(row.dateRange.to)}
            </span>
          )}
          {row.totalParsed != null && (
            <span>{row.totalParsed} parsed</span>
          )}
          {row.duplicatesVsDb != null && row.duplicatesVsDb > 0 && (
            <span className="text-amber-500">{row.duplicatesVsDb} already imported</span>
          )}
          {row.duplicateOfFile && (
            <span className="text-amber-500">
              {row.duplicateOfRows} rows duplicate of {row.duplicateOfFile}
            </span>
          )}
        </div>
      )}

      {row.mismatchReason && (
        <p className="rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-500">
          {row.mismatchReason}
        </p>
      )}
      {row.errorMessage && (
        <p className="rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-500">
          {row.errorMessage}
        </p>
      )}
    </li>
  );
}
