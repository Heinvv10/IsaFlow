import { CheckCircle2 } from 'lucide-react';

/** The shape POST /api/accounting/migration/chart-of-accounts actually returns. */
export interface CoaImportSummary {
  imported: number;
  skipped: number;
  errors: { row?: number; field?: string; message: string }[];
}

/**
 * Every entry in `errors` is shown, not just counted: a row that was imported
 * under a DEFAULT subtype is reported there too, and an operator who never
 * sees "imported as operating_expense" cannot know to reclassify cost of
 * sales before the first income statement.
 */
export function CoaImportResult({ result }: { result: CoaImportSummary }) {
  return (
    <div className="p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm mb-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4" />
        Imported {result.imported} accounts{result.skipped > 0 ? `, ${result.skipped} skipped` : ''}.
      </div>
      {result.errors.length > 0 && (
        <ul className="mt-2 ml-6 list-disc space-y-0.5 text-amber-600 dark:text-amber-400">
          {result.errors.map((e, i) => (
            <li key={i}>{e.row != null ? `Row ${e.row + 1}: ` : ''}{e.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
