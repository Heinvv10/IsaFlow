/**
 * StatementReviewPanel — PRD-05 Phase 7
 * Renders the review table + header card for a BankStatementImport.
 * Used by pages/accounting/bank/statements/import-pdf.tsx (review mode).
 */

import { useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, X, ChevronDown, ChevronUp } from 'lucide-react';

export type ImportStatus = 'extracted' | 'reviewing' | 'committed' | 'rolled_back';

export interface StatementRow {
  date: string; description: string; reference: string | null;
  amount: number; runningBalance: number | null;
  isDuplicate: boolean;
}

export interface BankStatementImport {
  id: string; bankAccountId: string;
  periodStart: string | null; periodEnd: string | null;
  openingBalance: number | null; closingBalance: number | null;
  rowCount: number; importedCount: number; duplicateCount: number;
  status: ImportStatus; rows: StatementRow[]; warnings: string[];
  createdAt: string; committedAt: string | null;
}

interface Props {
  imp: BankStatementImport;
  committing: boolean;
  rollingBack: boolean;
  onCommit: () => void;
  onRollback: () => void;
}

function fmtZAR(n: number) {
  return 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(s: string | null) {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('en-ZA'); } catch { return String(s); }
}

const TH = 'px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-[var(--ff-text-tertiary)]';

export function StatementReviewPanel({ imp, committing, rollingBack, onCommit, onRollback }: Props) {
  const [showWarnings, setShowWarnings] = useState(false);
  const newCount = imp.rowCount - imp.duplicateCount;

  return (
    <div className="space-y-4">
      {/* Header card */}
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Period</p>
            <p className="text-[var(--ff-text-primary)] font-medium">{fmtDate(imp.periodStart)} – {fmtDate(imp.periodEnd)}</p>
          </div>
          <div>
            <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Opening balance</p>
            <p className="font-mono text-[var(--ff-text-primary)]">{imp.openingBalance != null ? fmtZAR(imp.openingBalance) : '—'}</p>
          </div>
          <div>
            <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Closing balance</p>
            <p className="font-mono text-[var(--ff-text-primary)]">{imp.closingBalance != null ? fmtZAR(imp.closingBalance) : '—'}</p>
          </div>
          <div>
            <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Rows / Duplicates</p>
            <p className="text-[var(--ff-text-primary)]">{imp.rowCount} / <span className="text-amber-400">{imp.duplicateCount}</span></p>
          </div>
        </div>
        {imp.warnings.length > 0 && (
          <div className="mt-3 border-t border-[var(--ff-border-light)] pt-3">
            <button onClick={() => setShowWarnings(v => !v)} className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 transition-colors">
              {showWarnings ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              Warnings: {imp.warnings.length}
            </button>
            {showWarnings && (
              <ul className="mt-2 space-y-1 pl-2">
                {imp.warnings.map((w, i) => <li key={i} className="text-xs text-amber-300">• {w}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Rows table */}
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)]">
              <th className={TH}>Date</th><th className={TH}>Description</th>
              <th className={TH}>Reference</th><th className={`${TH} text-right`}>Amount</th>
              <th className={`${TH} text-right`}>Balance</th><th className={TH}>Status</th>
            </tr>
          </thead>
          <tbody>
            {imp.rows.map((row, i) => (
              <tr key={i} className="border-b border-[var(--ff-border-light)] last:border-0 hover:bg-white/5">
                <td className="px-4 py-2.5 text-xs font-mono text-[var(--ff-text-secondary)]">{fmtDate(row.date)}</td>
                <td className="px-4 py-2.5 text-xs text-[var(--ff-text-primary)] max-w-[220px] truncate" title={row.description}>{row.description}</td>
                <td className="px-4 py-2.5 text-xs text-[var(--ff-text-tertiary)]">{row.reference ?? '—'}</td>
                <td className={`px-4 py-2.5 text-xs font-mono text-right ${row.amount < 0 ? 'text-red-400' : 'text-teal-400'}`}>{fmtZAR(row.amount)}</td>
                <td className="px-4 py-2.5 text-xs font-mono text-right text-[var(--ff-text-secondary)]">{row.runningBalance != null ? fmtZAR(row.runningBalance) : '—'}</td>
                <td className="px-4 py-2.5">
                  {row.isDuplicate
                    ? <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-red-500/15 text-red-400 border-red-500/30">Duplicate</span>
                    : <span className="inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium bg-teal-500/15 text-teal-400 border-teal-500/30">New</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer actions */}
      <div className="flex flex-wrap items-center gap-3 pb-6">
        <button onClick={onCommit} disabled={imp.status !== 'extracted' || committing}
          className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white transition-colors">
          {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Commit {newCount} new row{newCount !== 1 ? 's' : ''}
        </button>
        <button onClick={onRollback} disabled={imp.status === 'rolled_back' || rollingBack}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-50 transition-colors">
          {rollingBack ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          Rollback
        </button>
      </div>

      {/* Inline error slot */}
      <AlertCircle className="hidden" aria-hidden />
    </div>
  );
}
