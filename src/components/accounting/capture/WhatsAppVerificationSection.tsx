import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';

type Active = { address: string; isActive: boolean };
type Pending = { address: string; expiresAt: string; verificationUrl?: string };
type State = { active: Active | null; pending: Pending | null };

/** Provider verification is separate from saving a proposed number. */
export function WhatsAppVerificationSection() {
  const [state, setState] = useState<State>({ active: null, pending: null });
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const response = await apiFetch('/api/accounting/capture/whatsapp-inbox');
      const json = await response.json() as { data?: State; error?: string };
      if (!response.ok || !json.data) throw new Error(json.error ?? 'Unable to load WhatsApp status');
      const next = json.data;
      setState(previous => ({ ...next, pending: next.pending && {
        ...next.pending,
        verificationUrl: previous.pending?.address === next.pending.address
          && previous.pending.expiresAt === next.pending.expiresAt ? previous.pending.verificationUrl : undefined,
      } }));
      setAddress(current => current || next.pending?.address || next.active?.address || '');
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load WhatsApp status');
    } finally { setLoaded(true); setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function start() {
    setBusy(true); setCopied(false);
    try {
      const response = await apiFetch('/api/accounting/capture/whatsapp-inbox', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: address.trim() }),
      });
      const json = await response.json() as { data?: Pending; error?: string };
      if (!response.ok || !json.data) throw new Error(json.error ?? 'Unable to start verification');
      const pending = json.data;
      setState(previous => ({ ...previous, pending })); setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start verification');
    } finally { setBusy(false); }
  }
  async function copy() {
    if (!state.pending?.verificationUrl) return;
    try { await navigator.clipboard.writeText(state.pending.verificationUrl); setCopied(true); }
    catch { setError('Unable to copy. Select and copy the verification URL.'); }
  }
  return <div className="space-y-4">
    <p className="text-sm text-slate-400">Verify your WhatsApp Business number before receiving documents.</p>
    {!loaded && <p role="status" className="text-sm text-slate-400">Loading WhatsApp status…</p>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {state.active && <p className="text-sm text-slate-300">
      {state.active.isActive ? 'Verified number: ' : 'Verification required for existing number: '}
      <span className="font-mono">{state.active.address}</span>
    </p>}
    {loaded && !state.active && !state.pending && <p className="text-sm text-slate-500">No verified WhatsApp number.</p>}
    <div className="flex gap-2">
      <input aria-label="WhatsApp Business number" type="tel" inputMode="tel" value={address}
        onChange={event => setAddress(event.target.value)} placeholder="+27821234567"
        className="flex-1 min-w-0 px-3 py-2 rounded-lg text-sm bg-white/5 border border-white/10 text-slate-200" />
      <button onClick={start} disabled={busy || !address.trim()} className="px-4 py-2 rounded-lg text-sm bg-green-700 text-white disabled:opacity-50">
        {state.pending ? 'Restart verification' : 'Start verification'}
      </button>
    </div>
    {state.pending && <div className="space-y-2 rounded-lg border border-amber-700/40 p-3">
      <p role="status" className="text-sm text-amber-300">Pending verification: {state.pending.address}</p>
      {state.pending.verificationUrl ? <>
        <p className="text-sm text-slate-400">Set this number’s incoming-message webhook in Twilio to the URL below, then send a message to the number. Check status afterwards.</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all text-xs text-slate-300">{state.pending.verificationUrl}</code>
          <button onClick={copy} className="text-sm text-teal-400">{copied ? 'Copied' : 'Copy verification URL'}</button>
        </div>
        <p className="text-xs text-slate-500">Keep this URL private. Verification expires {new Date(state.pending.expiresAt).toLocaleString()}.</p>
      </> : <p className="text-sm text-slate-400">The verification URL is shown only when you start. If it is already configured in Twilio, check status; otherwise restart to get a new URL.</p>}
      <p className="text-xs text-slate-400">Your previously verified number stays connected during verification. A number reserved by another company requires support review.</p>
    </div>}
    <button onClick={load} disabled={busy} className="text-sm text-teal-400 disabled:opacity-50">Check verification status</button>
  </div>;
}
