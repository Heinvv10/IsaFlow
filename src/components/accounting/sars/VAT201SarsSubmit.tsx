/**
 * VAT201 → SARS direct-submit panel (ISV channel).
 *
 * DARK by default: self-gates on GET /api/accounting/sars/efiling-status —
 * renders nothing unless the server has the ISV channel configured. When
 * armed, the "Submit to SARS" button is enabled ONLY when a draft is saved AND
 * the pre-filing exceptions report is clean; otherwise a "do not file" banner
 * blocks it (the exceptions gate is the differentiator). The server re-checks
 * the same gate — this is convenience, not the enforcement.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Send, ShieldCheck, ShieldAlert, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Props {
  /** Saved draft submission id — '' until the user saves a draft. */
  submissionId: string;
  /** True once the exceptions report has loaded (clean or not). */
  exceptionsReady: boolean;
  exceptionsClean: boolean;
}

interface SubmitResult {
  correlationId?: string;
  status?: string;
  sarsReference?: string | null;
  errors?: string[];
}

export function VAT201SarsSubmit({ submissionId, exceptionsReady, exceptionsClean }: Props) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SubmitResult | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/accounting/sars/efiling-status', { credentials: 'include' });
        const json = await res.json();
        if (!cancelled.current) setConfigured(res.ok ? Boolean(json.data?.configured) : false);
      } catch {
        if (!cancelled.current) setConfigured(false);
      }
    })();
    return () => { cancelled.current = true; };
  }, []);

  // A new draft (or regenerated period) resets any prior submit result so the
  // gate + button reflect the current return, not the last one.
  useEffect(() => { setResult(null); setError(''); }, [submissionId]);

  // Dark unless the server has the ISV channel armed.
  if (configured !== true) return null;

  const call = async (action: 'submit' | 'poll') => {
    if (!submissionId) return;
    setBusy(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/sars/efiling-submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ submissionId, action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      setResult(json.data as SubmitResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'SARS eFiling failed');
    } finally {
      setBusy(false);
    }
  };

  const blocked = !exceptionsClean;

  return (
    <div data-testid="sars-submit-section" className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        {blocked
          ? <ShieldAlert className="h-5 w-5 text-amber-400" />
          : <ShieldCheck className="h-5 w-5 text-emerald-400" />}
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Submit to SARS eFiling</h2>
      </div>

      {!submissionId && (
        <p className="text-sm text-[var(--ff-text-secondary)]">Save a draft first to enable direct submission.</p>
      )}

      {submissionId && !exceptionsReady && (
        <p className="text-sm text-[var(--ff-text-secondary)] flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking pre-filing exceptions…
        </p>
      )}

      {submissionId && exceptionsReady && blocked && (
        <div data-testid="sars-do-not-file-banner" className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
          <span><strong>Do not file.</strong> Clear the pre-filing exceptions above before submitting this return to SARS.</span>
        </div>
      )}

      {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}

      {result && (
        <div className="p-3 rounded-lg bg-emerald-500/10 text-emerald-400 text-sm space-y-1">
          <div>Status: <strong>{result.status}</strong>{result.sarsReference ? ` · SARS ref ${result.sarsReference}` : ''}</div>
          {result.correlationId && <div className="text-xs opacity-80">Correlation: {result.correlationId}</div>}
          {result.errors && result.errors.length > 0 && (
            <ul className="text-xs text-red-400 list-disc pl-4">{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          data-testid="sars-submit-btn"
          onClick={() => void call('submit')}
          disabled={busy || blocked || !submissionId || !exceptionsReady || !!result}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Submit to SARS
        </button>
        {result?.correlationId && (
          <button
            onClick={() => void call('poll')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" /> Refresh status
          </button>
        )}
      </div>
    </div>
  );
}
