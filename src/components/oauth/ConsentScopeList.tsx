/**
 * Consent scope list — the "this app would like to" block on the OAuth
 * authorize screen. Auto-granted scopes render as a static list; opt-in
 * scopes (write:post) render as UNCHECKED amber checkboxes the user must
 * actively tick. Extracted from pages/oauth/authorize.tsx to keep that file
 * under the 300-line cap.
 */
import { Check, AlertTriangle } from 'lucide-react';
import type { OAuthScope } from '@/lib/auth/oauth';

// Typed against the OAuth vocabulary: adding a scope to OAUTH_SCOPES without a
// label here fails tsc.
const SCOPE_LABELS: Record<OAuthScope, string> = {
  'read:invoices': 'Read your invoices',
  'write:invoices': 'Create and edit invoices',
  'read:bank-tx': 'Read your bank transactions',
  'write:bank-tx': 'Allocate and post bank transactions',
  'write:journals': 'Post General Ledger journals',
  'write:accounts': 'Create and edit your chart of accounts',
  'read:reports': 'Read your financial reports',
  'read:contacts': 'Read your customers and suppliers',
  'read:vat': 'Read your VAT status',
  // Copy tracks what the grant actually permits: it now also unlocks automated
  // bank allocation, which posts AP/AR journals, records customer payments as
  // confirmed, and marks supplier invoices paid. Keep in step with
  // PAT_SCOPE_META['write:post'].
  'write:post': 'Post journals, finalize documents, and allocate bank transactions to your ledger (irreversible)',
  'offline_access': 'Stay connected (refresh access in the background)',
};

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
        <div className="space-y-2">
          {optIn.map((s) => (
            <label
              key={s}
              className="flex items-start gap-3 text-sm rounded-lg border border-amber-800/50 bg-amber-900/20 px-3 py-2.5 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={optInChecked[s] ?? false}
                onChange={(e) => onToggle(s, e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-amber-500"
              />
              <span className="flex items-start gap-2 text-amber-200">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{label(s)}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </>
  );
}
