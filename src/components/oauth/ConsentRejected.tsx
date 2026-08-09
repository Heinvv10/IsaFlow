/**
 * The OAuth authorize screen's rejection frame — shown when the request itself
 * is malformed or unauthorised (unknown client, unregistered redirect_uri,
 * missing PKCE, no company to grant against). Extracted from
 * pages/oauth/authorize.tsx to keep that file under the 300-line cap, same as
 * ConsentScopeList and ConsentCompanyPicker.
 *
 * Deliberately does NOT offer a retry or a link back into the app: at this
 * point the request is untrustworthy, and the safest action is to close it.
 */
import { AlertTriangle } from 'lucide-react';

export function ConsentRejected({ error }: { error: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
      <div className="max-w-md w-full bg-slate-900 border border-red-800/40 rounded-xl p-6">
        <div className="flex items-start gap-3 mb-3">
          <AlertTriangle className="h-6 w-6 text-red-400 shrink-0" />
          <div>
            <h1 className="text-lg font-semibold">Authorisation request rejected</h1>
            <p className="text-sm text-slate-400 mt-1">{error}</p>
          </div>
        </div>
        <p className="text-xs text-slate-500 mt-4">
          If you didn&apos;t initiate this request, you can safely close this page.
        </p>
      </div>
    </div>
  );
}
