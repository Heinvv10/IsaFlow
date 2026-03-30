/**
 * WizardParts — shared UI atoms for ExternalMigrationWizard.
 * Extracted to keep ExternalMigrationWizard.tsx under 300 lines.
 */

import { useState, useRef } from 'react';
import { CheckCircle2, Upload, Loader2, RotateCcw } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { MigrationSource } from '@/modules/accounting/services/migrationParserService';

type Step = 'upload' | 'mapping' | 'review' | 'verify';

// ── Step indicator ────────────────────────────────────────────────────────────

export function StepIndicator({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: 'upload', label: 'Upload' },
    { id: 'mapping', label: 'Mapping' },
    { id: 'review', label: 'Review' },
    { id: 'verify', label: 'Verify' },
  ];
  const idx = steps.findIndex(s => s.id === step);
  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-center gap-2">
          <div className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${i <= idx ? 'bg-blue-500 text-white' : 'bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]'}`}>
            {i < idx ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
          </div>
          <span className={`text-xs ${i === idx ? 'text-[var(--ff-text-primary)] font-medium' : 'text-[var(--ff-text-tertiary)]'}`}>
            {s.label}
          </span>
          {i < steps.length - 1 && <div className="w-6 h-px bg-[var(--ff-border-light)]" />}
        </div>
      ))}
    </div>
  );
}

// ── File upload zone ──────────────────────────────────────────────────────────

export function FileUploadZone({ label, hint, required, count, loading, onFile }: {
  label: string; hint: string; required?: boolean; count: number;
  loading: boolean; onFile: (f: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[var(--ff-text-primary)]">
            {label} {required && <span className="text-red-400 text-xs">*required</span>}
          </p>
          <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">{hint}</p>
          {count > 0 && <p className="text-xs text-teal-400 mt-1">{count} records parsed</p>}
        </div>
        <div className="shrink-0">
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
          ) : (
            <>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.txt,.xlsx"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }}
              />
              <button
                onClick={() => inputRef.current?.click()}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${count > 0 ? 'bg-teal-500/10 text-teal-400 hover:bg-teal-500/20' : 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20'}`}
              >
                <Upload className="h-3.5 w-3.5" />
                {count > 0 ? 'Re-upload' : 'Upload'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Summary card ──────────────────────────────────────────────────────────────

export function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="p-3 rounded-lg bg-[var(--ff-bg-primary)]">
      <p className="text-xs text-[var(--ff-text-tertiary)]">{label}</p>
      <p className="text-xl font-bold text-[var(--ff-text-primary)]">{value}</p>
    </div>
  );
}

// ── Verify table ──────────────────────────────────────────────────────────────

export interface VerifyEntry {
  accountCode: string;
  sourceName: string;
  sourceBalance: number;
  isaflowBalance: number;
  difference: number;
  matched: boolean;
}

export function VerifyTable({ results }: { results: VerifyEntry[] }) {
  const allMatched = results.every(r => r.matched);
  return (
    <div className="rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
      <div className={`px-4 py-2 text-sm font-medium ${allMatched ? 'bg-teal-500/10 text-teal-400' : 'bg-amber-500/10 text-amber-400'}`}>
        {allMatched ? 'All balances matched' : `${results.filter(r => !r.matched).length} balance(s) differ`}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]">
            <th className="text-left px-3 py-2 text-[var(--ff-text-secondary)]">Account</th>
            <th className="text-right px-3 py-2 text-[var(--ff-text-secondary)]">Source</th>
            <th className="text-right px-3 py-2 text-[var(--ff-text-secondary)]">ISAFlow</th>
            <th className="text-right px-3 py-2 text-[var(--ff-text-secondary)]">Diff</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--ff-border-light)]">
          {results.map(r => (
            <tr key={r.accountCode} className={r.matched ? '' : 'bg-red-500/5'}>
              <td className="px-3 py-2 text-[var(--ff-text-primary)]">
                <span className="font-mono text-xs mr-2">{r.accountCode}</span>{r.sourceName}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">{r.sourceBalance.toFixed(2)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">{r.isaflowBalance.toFixed(2)}</td>
              <td className={`px-3 py-2 text-right font-mono text-xs ${r.matched ? 'text-teal-400' : 'text-red-400'}`}>
                {r.difference.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Rollback button ───────────────────────────────────────────────────────────

export function RollbackButton({ source }: { source: MigrationSource }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleRollback = async () => {
    if (!confirm(`This will delete all GL accounts imported from ${source}. Continue?`)) return;
    setLoading(true);
    try {
      await apiFetch('/api/accounting/migration-rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      setDone(true);
    } finally {
      setLoading(false);
    }
  };

  if (done) return <span className="text-xs text-teal-400">Rollback complete</span>;

  return (
    <button
      onClick={handleRollback}
      disabled={loading}
      className="flex items-center gap-1.5 text-xs text-[var(--ff-text-tertiary)] hover:text-red-400 disabled:opacity-50"
    >
      <RotateCcw className="h-3.5 w-3.5" />
      {loading ? 'Rolling back...' : 'Rollback import'}
    </button>
  );
}
