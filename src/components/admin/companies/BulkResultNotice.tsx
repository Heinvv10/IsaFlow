/**
 * The outcome of a bulk company action (audit 3.7): the API answers 200 with `{ processed, errors[] }`, and the
 * page used to drop both, so a partial failure looked like success.
 */

import { AlertCircle, CheckCircle2, X } from 'lucide-react';

export interface BulkResult {
  label: string;
  processed: number;
  errors: string[];
}

interface Props {
  result: BulkResult;
  /** Company names by id, to print a name instead of the id an error starts with. */
  names: Record<string, string>;
  onDismiss: () => void;
}

export function BulkResultNotice({ result, names, onDismiss }: Props) {
  const failed = result.errors.length > 0;
  const named = (e: string) => {
    const [id, ...rest] = e.split(': ');
    return id && names[id] ? `${names[id]}: ${rest.join(': ')}` : e;
  };
  return (
    <div role="status" className={`flex items-start gap-2 p-3 rounded-lg text-sm mb-4 ${failed ? 'bg-red-500/10 text-red-500' : 'bg-teal-500/10 text-teal-600 dark:text-teal-400'}`}>
      {failed ? <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />}
      <div className="flex-1">
        <p>{result.label}: {result.processed} done{failed ? `, ${result.errors.length} failed` : ''}.</p>
        {failed && <ul className="mt-1 list-disc pl-5">{result.errors.map(e => <li key={e}>{named(e)}</li>)}</ul>}
      </div>
      <button onClick={onDismiss} aria-label="Dismiss" className="opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
    </div>
  );
}
