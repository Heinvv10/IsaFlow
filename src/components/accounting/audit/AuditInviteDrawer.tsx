/**
 * The auditor-invite drawer of the Evidence Packs page (moved out of pages/accounting/audit-packs/index.tsx to keep
 * it under the file-size limit): portal sessions for one pack — create a time-limited link, list, revoke.
 */
import { useEffect, useState } from 'react';
import { Copy, Check, X } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { formatDisplayDateTime } from '@/utils/dateFormat';

interface PortalSession {
  id: string;
  auditorEmail: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  return formatDisplayDateTime(s);
}

async function fetchSessions(exportId: string): Promise<PortalSession[]> {
  const res = await apiFetch(`/api/accounting/audit-exports/${exportId}/sessions`);
  await assertOk(res, 'Could not load the auditor sessions - try again');
  return ((await res.json()) as { data?: { sessions?: PortalSession[] } }).data?.sessions ?? [];
}

interface Props { exportId: string; onClose: () => void; notify: (msg: string, ok?: boolean) => void }

export function AuditInviteDrawer({ exportId, onClose, notify }: Props) {
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteTtl, setInviteTtl] = useState('168');
  const [inviteResult, setInviteResult] = useState<{ portalUrl: string; accessToken: string } | null>(null);
  const [sessions, setSessions] = useState<PortalSession[]>([]);
  const [copiedUrl, setCopiedUrl] = useState(false);

  useEffect(() => {
    fetchSessions(exportId).then(setSessions, (err: unknown) => {
      setSessions([]);
      notify(apiErrorMessage(err, 'Could not load the auditor sessions - try again'), false);
    });
  }, [exportId, notify]);

  async function handleInvite() {
    if (!inviteEmail) return;
    try {
      const res = await apiFetch(`/api/accounting/audit-exports/${exportId}/sessions`, {
        method: 'POST',
        body: JSON.stringify({ auditorEmail: inviteEmail, ttlHours: parseInt(inviteTtl, 10) }),
      });
      await assertOk(res, 'Could not create the auditor invite - try again');
      const json = await res.json() as { data?: { portalUrl?: string; accessToken?: string } };
      if (!json.data?.portalUrl) { notify('Could not create the auditor invite - try again', false); return; }
      setInviteResult({ portalUrl: json.data.portalUrl, accessToken: json.data.accessToken ?? '' });
      setInviteEmail('');
    } catch (err) { notify(apiErrorMessage(err, 'Could not create the auditor invite - try again'), false); return; }
    try { setSessions(await fetchSessions(exportId)); } catch (err) { setSessions([]); notify(apiErrorMessage(err, 'Could not load the auditor sessions - try again'), false); }
  }

  async function revokeSession(id: string) {
    if (!confirm('Revoke this auditor session?')) return;
    try {
      const res = await apiFetch(`/api/accounting/audit-exports/${exportId}/sessions/${id}`, { method: 'DELETE' });
      await assertOk(res, 'Could not revoke the session - try again');
      notify('Revoked', true);
    } catch (err) { notify(apiErrorMessage(err, 'Could not revoke the session - try again'), false); return; }
    try { setSessions(await fetchSessions(exportId)); } catch (err) { setSessions([]); notify(`Session revoked, but the session list did not refresh: ${apiErrorMessage(err, 'try again')}`, false); }
  }

  async function copyUrl(url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-40 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-xl h-full bg-[var(--ff-canvas-mid)] border-l border-[rgba(255,255,255,0.08)] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[rgba(255,255,255,0.08)] flex items-center justify-between">
          <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">Invite auditor</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200">✕</button>
        </div>
        <div className="px-5 py-4 space-y-4 text-sm">
          <div className="bg-white/5 border border-[rgba(255,255,255,0.08)] rounded-lg p-3 space-y-2">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Auditor email</label>
              <input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="auditor@firm.co.za"
                className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">TTL (hours)</label>
              <input type="number" value={inviteTtl} onChange={e => setInviteTtl(e.target.value)}
                className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200" />
            </div>
            <button onClick={() => void handleInvite()}
              className="w-full mt-1 px-4 py-2 rounded bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium">
              Create portal link
            </button>
          </div>

          {inviteResult && (
            <div className="bg-teal-900/20 border border-teal-700/40 rounded-lg p-3 space-y-2">
              <p className="text-xs text-teal-300 font-semibold">Copy this now — it won&rsquo;t be shown again</p>
              <div className="flex items-center gap-2">
                <input readOnly value={inviteResult.portalUrl}
                  className="flex-1 px-2 py-1 rounded bg-black/40 border border-[rgba(255,255,255,0.1)] text-slate-200 font-mono text-xs" />
                <button onClick={() => void copyUrl(inviteResult.portalUrl)}
                  className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-slate-300 text-xs">
                  {copiedUrl ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          )}

          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Existing sessions</p>
            {sessions.length === 0 ? (
              <p className="text-xs text-slate-600">None yet</p>
            ) : (
              <ul className="space-y-2">
                {sessions.map(s => (
                  <li key={s.id} className="flex items-start justify-between px-3 py-2 rounded bg-white/5">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-200 truncate">{s.auditorEmail}</p>
                      <p className="text-xs text-slate-500">
                        {s.revokedAt ? 'Revoked' : `Expires ${fmtDate(s.expiresAt)}`} · used {s.useCount}×
                      </p>
                    </div>
                    {!s.revokedAt && (
                      <button onClick={() => void revokeSession(s.id)}
                        className="p-1 text-red-400 hover:text-red-300" title="Revoke">
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
