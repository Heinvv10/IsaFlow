/**
 * The workspace's empty states (spec §6.4): no version for the FY yet → one button per wizard
 * source; no revenue or expense accounts → a link to the chart of accounts. A role without
 * write access is told who can create one instead of being shown buttons the server refuses.
 */
import Link from 'next/link';
import { FileSpreadsheet, Copy, Sparkles, Square } from 'lucide-react';
import type { SourceChoice } from './wizardDraft';

export interface WorkspaceEmptyStateProps {
  fiscalYear: number;
  /** The year has no revenue or expense accounts to budget. */
  noAccounts: boolean;
  canWrite: boolean;
  /** Another version exists somewhere to copy from (the "Copy a version" source). */
  canCopy: boolean;
  onStart: (source: SourceChoice) => void;
}

const SOURCES: Array<{ source: SourceChoice; label: string; hint: string; Icon: typeof Copy }> = [
  { source: 'py_actuals', label: 'From last year\'s actuals', hint: 'Prior-year actuals, plus or minus a percentage', Icon: Sparkles },
  { source: 'version', label: 'Copy a version', hint: 'Another budget version, plus or minus a percentage', Icon: Copy },
  { source: 'blank', label: 'Start blank', hint: 'Every account empty; paste from Excel or type', Icon: Square },
  { source: 'import', label: 'Import from Excel', hint: 'Download the template, fill it in, upload it', Icon: FileSpreadsheet },
];

const PANEL = 'rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-6';

export function WorkspaceEmptyState({ fiscalYear, noAccounts, canWrite, canCopy, onStart }: WorkspaceEmptyStateProps) {
  if (noAccounts) {
    return (
      <div className={PANEL} data-testid="workspace-empty-accounts">
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">No revenue or expense accounts</h2>
        <p className="mt-1 text-sm text-[var(--ff-text-secondary)]">
          A budget is set per revenue and expense account. Add them to your chart of accounts first.
        </p>
        <Link href="/accounting/chart-of-accounts" className="mt-4 inline-block text-sm font-medium text-[var(--ff-brand)] underline">
          Open the chart of accounts
        </Link>
      </div>
    );
  }
  return (
    <div className={PANEL} data-testid="workspace-empty">
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">No budget for FY{fiscalYear} yet</h2>
      {!canWrite && (
        <p className="mt-1 text-sm text-[var(--ff-text-secondary)]">An owner, admin or manager can create one.</p>
      )}
      {canWrite && (
        <>
          <p className="mt-1 text-sm text-[var(--ff-text-secondary)]">Choose how to start it.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {SOURCES.filter((s) => s.source !== 'version' || canCopy).map(({ source, label, hint, Icon }) => (
              <button key={source} type="button" onClick={() => onStart(source)} data-testid={`empty-start-${source}`}
                className="flex items-start gap-3 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] p-4 text-left hover:bg-[var(--ff-bg-hover)]">
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ff-brand)]" aria-hidden="true" />
                <span>
                  <span className="block text-sm font-medium text-[var(--ff-text-primary)]">{label}</span>
                  <span className="block text-xs text-[var(--ff-text-secondary)]">{hint}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
