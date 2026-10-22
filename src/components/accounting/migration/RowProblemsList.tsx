/**
 * Rows the wizard could not read (an amount like "12x", a date like 31/02/2026),
 * listed before import. These used to import silently as 0 or fail at the
 * database; the operator now sees each one by row and fixes the file.
 */
import { AlertCircle } from 'lucide-react';

export function RowProblemsList({ problems, max = 20 }: { problems: string[]; max?: number }) {
  if (problems.length === 0) return null;
  return (
    <div role="alert" className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm space-y-1">
      <p className="flex items-center gap-2 font-medium">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {problems.length} row(s) could not be read. Fix them in the file and upload it again:
      </p>
      {problems.slice(0, max).map((p, i) => <p key={i} className="text-xs pl-6">{p}</p>)}
      {problems.length > max && <p className="text-xs pl-6">...and {problems.length - max} more</p>}
    </div>
  );
}
