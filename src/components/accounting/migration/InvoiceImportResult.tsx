/**
 * The outcome of an AR or AP invoice import step, as the wizard shows it.
 *
 * Both pages rendered `Imported {result.succeeded} … Failed: {result.failed}` —
 * fields the service has never returned, so both numbers read `undefined`. It
 * returns `imported` / `skipped`, plus the per-row errors and the R-002
 * rounding warnings, and a row that imported with drift is exactly the thing
 * the operator has to see.
 */
import { AlertCircle, CheckCircle2 } from 'lucide-react';

export interface ImportIssue {
  message: string;
  severity?: 'error' | 'warning';
}

export interface InvoiceImportResultData {
  imported: number;
  skipped: number;
  errors?: ImportIssue[];
  warnings?: ImportIssue[];
}

export default function InvoiceImportResult({ result }: { result: InvoiceImportResultData }) {
  return (
    <div className="space-y-2 mb-4">
      <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">
        <CheckCircle2 className="h-4 w-4" />
        Imported {result.imported} invoices. Skipped: {result.skipped}.
      </div>
      {(result.warnings ?? []).map((w, i) => (
        <div key={`w${i}`} className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-400 text-sm">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /> {w.message}
        </div>
      ))}
      {(result.errors ?? []).map((e, i) => (
        <div key={`e${i}`} className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /> {e.message}
        </div>
      ))}
    </div>
  );
}
