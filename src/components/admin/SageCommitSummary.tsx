/**
 * The result panel of the Sage auto-import.
 *
 * Split out of pages/admin/tools/sage-import.tsx so it can be rendered in a
 * test: `warnings` carries the only record that a customer credit was dropped
 * or a source amount refused, and a summary the operator never sees is the same
 * as no warning at all.
 */

const COMMIT_KEYS = ['accounts', 'customers', 'suppliers', 'arInvoices', 'apInvoices'] as const;

export type SageCommitKey = typeof COMMIT_KEYS[number];

export type SageCommitSummaryData =
  Record<SageCommitKey, { created: number; skipped: number; failed: string[] }>
  & { warnings?: string[] };

export function SageCommitSummary({ summary }: { summary: SageCommitSummaryData }) {
  const failures = COMMIT_KEYS.flatMap(k => summary[k].failed.map(f => `[${k}] ${f}`));
  const warnings = summary.warnings ?? [];

  return (
    <div className="space-y-2 text-sm">
      {COMMIT_KEYS.map(k => (
        <div key={k} className="flex items-center justify-between gap-4 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900/40">
          <span className="font-medium text-gray-900 dark:text-white capitalize">{k.replace('Invoices', ' Invoices')}</span>
          <span className="text-gray-600 dark:text-gray-400">
            <span className="text-teal-600 dark:text-teal-400">{summary[k].created} created</span>{' · '}
            <span>{summary[k].skipped} skipped</span>
            {summary[k].failed.length > 0 && (
              <>{' · '}<span className="text-red-600 dark:text-red-400">{summary[k].failed.length} failed</span></>
            )}
          </span>
        </div>
      ))}

      {warnings.length > 0 && (
        <details className="pt-2" open>
          <summary className="cursor-pointer text-xs text-amber-600 dark:text-amber-400">
            {warnings.length} warning{warnings.length === 1 ? '' : 's'} — imported, but the source data was not fully representable
          </summary>
          <pre className="text-xs mt-2 p-3 rounded bg-amber-500/5 text-amber-700 dark:text-amber-300 max-h-64 overflow-auto whitespace-pre-wrap">
{warnings.join('\n')}
          </pre>
        </details>
      )}

      {failures.length > 0 && (
        <details className="pt-2">
          <summary className="cursor-pointer text-xs text-red-600 dark:text-red-400">Show failures</summary>
          <pre className="text-xs mt-2 p-3 rounded bg-red-500/5 text-red-700 dark:text-red-300 max-h-64 overflow-auto whitespace-pre-wrap">
{failures.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}
