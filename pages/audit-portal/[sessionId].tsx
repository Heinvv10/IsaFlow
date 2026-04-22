/**
 * Auditor portal — PRD-05 Phase 12.
 * Token-gated read-only view of a single audit pack. The access token comes
 * in via ?token=... and is never stored client-side.
 */

import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import Head from 'next/head';
import { ShieldCheck, Download, Loader2, AlertCircle } from 'lucide-react';

export default function AuditPortalPage() {
  const router = useRouter();
  const { sessionId, token } = router.query as { sessionId?: string; token?: string };
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!sessionId || !token) return;
    // Ping the download endpoint with HEAD to validate; on 200 we enable the download button.
    void (async () => {
      try {
        const res = await fetch(`/api/audit-portal/download?sessionId=${sessionId}&token=${token}`, { method: 'HEAD' });
        if (res.ok) {
          setReady(true);
        } else if (res.status === 401) {
          setError('Session invalid or expired. Please contact the company that issued this link.');
        } else {
          setError(`Pack unavailable (HTTP ${res.status})`);
        }
      } catch {
        setError('Network error — try again.');
      }
    })();
  }, [sessionId, token]);

  const downloadHref = sessionId && token
    ? `/api/audit-portal/download?sessionId=${sessionId}&token=${token}`
    : '#';

  return (
    <>
      <Head><title>Audit Portal — IsaFlow</title></Head>
      <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-xl p-8">
          <div className="flex items-center gap-3 mb-4">
            <ShieldCheck className="h-6 w-6 text-teal-400" />
            <h1 className="text-xl font-semibold">Audit Pack Portal</h1>
          </div>

          {!sessionId || !token ? (
            <div className="flex items-center gap-2 text-red-400">
              <AlertCircle className="h-5 w-5" />
              <span className="text-sm">This link is missing its access token. Ask your client to re-send the portal link.</span>
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400">
              <AlertCircle className="h-5 w-5" />
              <span className="text-sm">{error}</span>
            </div>
          ) : !ready ? (
            <div className="flex items-center gap-2 text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Validating access token…</span>
            </div>
          ) : (
            <>
              <p className="text-sm text-slate-400 mb-5">
                Your client has granted you read-only access to an evidence pack. The PDF is cryptographically sealed — the
                <code className="mx-1 px-1.5 py-0.5 rounded bg-slate-800 text-xs font-mono">X-Content-SHA256</code> response header
                matches the hash stored by IsaFlow at build time.
              </p>
              <a href={downloadHref}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium">
                <Download className="h-4 w-4" /> Download audit pack (PDF)
              </a>
              <p className="text-xs text-slate-600 mt-4">
                This portal is strictly read-only. All downloads are recorded against your session.
              </p>
            </>
          )}
        </div>
      </main>
    </>
  );
}
