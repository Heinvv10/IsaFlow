/**
 * Why a period (or a year) could not be closed: each refused period with its
 * failing readiness checks, the reason, and a Fix link to the screen that
 * clears it. Shown by every close screen in place of a generic error.
 */

import Link from 'next/link';
import { XCircle } from 'lucide-react';
import type { CloseRefusal } from './closeRefusal';

interface Props {
  refusal: CloseRefusal;
  onDismiss: () => void;
}

function heading({ fiscalYear, periods }: CloseRefusal): string {
  const n = periods.length;
  if (fiscalYear !== undefined) {
    return `FY ${fiscalYear} cannot be closed: ${n} period${n === 1 ? '' : 's'} failed the close checks. Nothing was closed.`;
  }
  if (n === 1) return `${periods[0]!.periodName} cannot be closed: fix these checks first.`;
  return `${n} periods could not be closed: fix these checks first.`;
}

export function CloseRefusalNotice({ refusal, onDismiss }: Props) {
  return (
    <div role="alert" data-testid="close-refusal"
      className="p-3 rounded-lg text-sm bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400">
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold flex items-center gap-1.5">
          <XCircle className="h-4 w-4 shrink-0" />{heading(refusal)}
        </p>
        <button onClick={onDismiss} className="text-xs underline opacity-70 hover:opacity-100">Dismiss</button>
      </div>
      {refusal.periods.map(p => (
        <div key={p.periodId || p.periodName} className="mt-2">
          <p className="font-medium">{p.periodName}</p>
          <ul className="mt-1 space-y-1 text-xs">
            {p.blockers.map(b => (
              <li key={b.key} className="flex items-start gap-2">
                <span className="flex-1">
                  <span className="font-semibold">{b.label}</span>
                  {' '}<span>{b.reason}</span>
                </span>
                <Link href={b.fixHref} className="shrink-0 font-semibold text-teal-600 dark:text-teal-400 hover:underline">
                  Fix
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
