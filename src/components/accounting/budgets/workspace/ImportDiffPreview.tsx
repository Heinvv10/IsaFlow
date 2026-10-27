/**
 * The Excel import preview (spec 9.2): counts, the changes grouped by account with a highlighted
 * mini-grid, possible-revert / conflict flags, errors and warnings, then Commit. Commit is
 * disabled while errors are listed unless "import valid rows only" is ticked (the server already
 * left the error rows out of `cells`), and when nothing changes. A mid-chain failure is shown
 * honestly with a re-run action; the parent runs the chained save.
 */
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { formatStatementFigure } from '@/lib/format/money';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import type { ImportPreview } from '@/modules/accounting/services/budgets/budgetImportDiff';
import type { ImportIssue } from '@/modules/accounting/services/budgets/budgetImportResolve';
import type { SaveCell } from '@/modules/accounting/services/budgets/gridSaveValidate';
import { changedAgo, groupChanges } from './importDiffModel';

export interface ImportFailure { message: string; failedChunk: number | null; chunks: number }

export interface ImportDiffPreviewProps {
  preview: ImportPreview;
  /** The version's months, 'YYYY-MM', in column order. */
  months: readonly string[];
  /** account id -> "code name"; member id -> "code name". */
  accountLabels: ReadonlyMap<string, string>;
  memberLabels: ReadonlyMap<string, string>;
  nowMs: number;
  busy: boolean;
  failure: ImportFailure | null;
  onCommit: (cells: SaveCell[]) => void;
  onRerun: () => void;
  onCancel: () => void;
}

const figure = (n: number | null) => (n === null ? '' : n === 0 ? '–' : formatStatementFigure(n));
const FIG = 'text-right whitespace-nowrap tabular-nums';
const MUTED = 'text-[var(--ff-text-tertiary)]';

function failureText(f: ImportFailure): string {
  if (f.failedChunk === null) return f.message;
  const saved = f.failedChunk > 1 ? 'earlier chunks were saved' : 'nothing was saved';
  return `Chunk ${f.failedChunk} of ${f.chunks} failed; ${saved}. ${f.message}`;
}

function Issues({ title, items, total, tone }: { title: string; items: readonly ImportIssue[]; total: number; tone: string }) {
  if (total === 0) return null;
  return (
    <section aria-label={title} className="space-y-1">
      <h4 className="text-sm font-semibold" style={{ color: tone }}>{total} {title.toLowerCase()}</h4>
      {total > items.length && <p className={`text-xs ${MUTED}`}>Only the first {items.length} listed.</p>}
      <ul className="max-h-32 overflow-y-auto text-xs space-y-0.5">
        {items.map((i, n) => (
          <li key={n} className="text-[var(--ff-text-secondary)]">{i.row > 0 ? `Row ${i.row}` : 'File'}{i.column ? `, ${i.column}` : ''}: {i.message}</li>
        ))}
      </ul>
    </section>
  );
}

export function ImportDiffPreview(p: ImportDiffPreviewProps) {
  const { preview } = p;
  const [validOnly, setValidOnly] = useState(false);
  const groups = groupChanges(preview.changes);
  const conflictKeys = new Set(preview.conflicts.map((c) => c.key));
  const hasErrors = preview.errorCount > 0;
  const nothing = preview.cells.length === 0;
  const blocked = p.busy || nothing || (hasErrors && !validOnly);
  const label = (id: string) => p.accountLabels.get(id) ?? id;

  return (
    <div className="space-y-4">
      <p data-testid="import-counts" className="flex flex-wrap gap-x-4 text-sm text-[var(--ff-text-secondary)]">
        <span>{preview.counts.added} added</span><span>{preview.counts.changed} changed</span>
        <span>{preview.counts.cleared} cleared</span><span>{preview.counts.unchanged} unchanged</span>
      </p>
      {nothing && <p className={`text-sm ${MUTED}`}>No changes: the file matches the budget as it is.</p>}
      {preview.conflicts.length > 0 && (
        <p className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--ff-warning-500)' }}>
          <AlertTriangle size={14} aria-hidden="true" />
          {preview.conflicts.length} conflict{preview.conflicts.length === 1 ? '' : 's'}: also changed in the budget since you downloaded; your value is applied.
        </p>
      )}
      <Issues title="Errors" items={preview.errors} total={preview.errorCount} tone="var(--ff-error-500)" />
      <Issues title="Warnings" items={preview.warnings} total={preview.warningCount} tone="var(--ff-warning-500)" />

      <div className="max-h-72 overflow-auto rounded border border-[var(--ff-border-light)]">
        {groups.map((g) => (
          <div key={g.rowKey} className="border-b border-[var(--ff-border-light)] p-2 last:border-b-0">
            <p className="text-sm font-medium text-[var(--ff-text-primary)]">
              {label(g.glAccountId)}{g.memberIds.length > 0 && ` · ${g.memberIds.map((m) => p.memberLabels.get(m) ?? m).join(' · ')}`}
            </p>
            <table className="mt-1 w-full text-xs" style={{ fontFamily: 'var(--ff-fig-font, inherit)' }}>
              <thead><tr>{p.months.map((m) => <th key={m} scope="col" className={`${FIG} ${MUTED} font-normal px-1`}>{monthLabel(m)}</th>)}</tr></thead>
              <tbody><tr>
                {p.months.map((m) => {
                  const c = g.byMonth.get(m);
                  const ago = c ? changedAgo(c.currentChangedAt, p.nowMs) : null;
                  return (
                    <td key={m} data-changed={c ? 'true' : 'false'} className={`${FIG} px-1 py-0.5`}
                        style={c ? { background: conflictKeys.has(c.key) ? 'var(--ff-conflict-bg)' : 'var(--ff-dirty-bg)' } : undefined}>
                      {c && (
                        <>
                          {figure(c.after)}
                          {c.before !== null && <span className={`block ${MUTED}`}>was {figure(c.before)}</span>}
                          {c.possibleRevert && <span className="block" style={{ color: 'var(--ff-warning-500)' }}>possible revert</span>}
                          {ago && <span className={`block ${MUTED}`}>{ago}</span>}
                        </>
                      )}
                    </td>
                  );
                })}
              </tr></tbody>
            </table>
          </div>
        ))}
      </div>

      {p.failure && (
        <div role="alert" className="rounded border border-[var(--ff-error-500)] p-3 text-sm text-[var(--ff-text-primary)]">
          <p>{failureText(p.failure)}</p>
          <Button variant="secondary" size="sm" className="mt-2" onClick={p.onRerun}>Re-run preview</Button>
        </div>
      )}

      {hasErrors && (
        <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
          <input type="checkbox" checked={validOnly} onChange={(e) => setValidOnly(e.target.checked)} />
          Import valid rows only
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={p.onCancel}>Cancel</Button>
        <Button disabled={blocked} onClick={() => p.onCommit(preview.cells)}>Commit {preview.cells.length} change{preview.cells.length === 1 ? '' : 's'}</Button>
      </div>
    </div>
  );
}
