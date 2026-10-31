/**
 * Consent scope list — the "this app would like to" block on the OAuth
 * authorize screen. Read scopes render as a static list; every requested write
 * scope renders as an individual checkbox. write:post keeps a stronger warning.
 */
import { Check, AlertTriangle } from 'lucide-react';
import type { OAuthScope } from '@/lib/auth/oauth';
import { SCOPE_LABELS } from '@/lib/auth/consentScopeLabels';

function label(scope: string): string {
  return SCOPE_LABELS[scope as OAuthScope] ?? scope;
}

interface Props {
  autoGranted: string[];
  optIn: string[];
  optInChecked: Record<string, boolean>;
  onToggle: (scope: string, checked: boolean) => void;
}

export function ConsentScopeList({ autoGranted, optIn, optInChecked, onToggle }: Props) {
  return (
    <>
      <div>
        <h2 className="text-sm font-medium text-slate-300 mb-2">This app would like to:</h2>
        <ul className="space-y-2">
          {autoGranted.map((s) => (
            <li key={s} className="flex items-start gap-2 text-sm text-slate-300">
              <Check className="h-4 w-4 text-teal-400 mt-0.5 shrink-0" />
              <span>{label(s)}</span>
            </li>
          ))}
        </ul>
      </div>

      {optIn.length > 0 && (
        <div className="space-y-2 pt-1">
          <p className="text-xs text-slate-400">
            Write permissions let this AI change your data. It only gets the write permissions you tick.
          </p>
          {optIn.map((s) => {
            const posting = s === 'write:post';
            return (
              <label
                key={s}
                className={posting
                  ? 'flex items-start gap-3 text-sm rounded-lg border border-amber-800/50 bg-amber-900/20 px-3 py-2.5 cursor-pointer'
                  : 'flex items-start gap-3 text-sm rounded-lg border border-slate-700 bg-slate-950/40 px-3 py-2.5 cursor-pointer'}
              >
                <input
                  type="checkbox"
                  checked={optInChecked[s] ?? false}
                  onChange={(e) => onToggle(s, e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-amber-500"
                />
                <span className={posting ? 'flex items-start gap-2 text-amber-200' : 'text-slate-300'}>
                  {posting && <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />}
                  <span>
                    {label(s)}
                    {posting && (
                      <span className="block text-xs text-amber-300/80 mt-1">
                        Can make irreversible ledger entries. Corrections use a reversing entry.
                      </span>
                    )}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </>
  );
}
