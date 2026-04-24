/**
 * Admin billing — Stitch LinkPay mandate card.
 * Renders on /admin/billing. Shows current mandate, recent charges, and
 * actions to authorise or revoke.
 */

import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { CreditCard, CheckCircle2, XCircle, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';

interface Mandate {
  id: string;
  status: 'active' | 'pending' | 'failed' | 'revoked' | 'expired';
  bank_name: string | null;
  masked_account_number: string | null;
  max_amount_cents: string;
  authorised_at: string | null;
}

interface Charge {
  id: string;
  period_start: string;
  period_end: string;
  amount_cents: string;
  status: 'queued' | 'submitted' | 'settled' | 'failed' | 'cancelled';
  attempt_count: number;
  last_attempt_at: string | null;
  settled_at: string | null;
  failure_reason: string | null;
}

interface StatusResponse {
  mandate: Mandate | null;
  charges: Charge[];
}

const STATUS_STYLES: Record<Charge['status'], string> = {
  settled: 'bg-emerald-100 text-emerald-700',
  submitted: 'bg-indigo-100 text-indigo-700',
  queued: 'bg-slate-100 text-slate-700',
  failed: 'bg-rose-100 text-rose-700',
  cancelled: 'bg-amber-100 text-amber-700',
};

export function StitchMandateCard() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/admin/billing/stitch/mandate/status');
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const json = (await res.json()) as { data: StatusResponse };
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load mandate');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const authorise = useCallback(async () => {
    const input = window.prompt('Authorisation ceiling per debit (in Rands, e.g. 1500)');
    const rands = Number(input);
    if (!rands || rands <= 0) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/admin/billing/stitch/mandate/create', {
        method: 'POST',
        body: JSON.stringify({ maxAmountCents: Math.round(rands * 100) }),
      });
      const json = (await res.json()) as { data?: { checkoutUrl: string }; error?: { message: string } };
      if (!res.ok || !json.data?.checkoutUrl) {
        throw new Error(json.error?.message ?? `Failed (${res.status})`);
      }
      window.location.href = json.data.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authorisation failed');
      setBusy(false);
    }
  }, []);

  const revoke = useCallback(async () => {
    if (!window.confirm('Revoke the active debit order? Future debits will stop.')) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/admin/billing/stitch/mandate/revoke', {
        method: 'POST',
        body: JSON.stringify({ reason: 'User revoked from admin UI' }),
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed');
    } finally {
      setBusy(false);
    }
  }, [load]);

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <CreditCard className="w-5 h-5 text-indigo-600" />
          <h2 className="text-lg font-semibold text-slate-900">Recurring debit (Stitch LinkPay)</h2>
        </div>
        <button
          type="button"
          onClick={load}
          className="text-slate-400 hover:text-slate-600"
          aria-label="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {loading && (
        <div className="py-6 flex items-center gap-2 text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading mandate…
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-rose-50 text-rose-700 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!loading && data && !data.mandate && (
        <div className="py-4">
          <p className="text-slate-600 mb-4">
            No debit order set up. Authorise once to enable automatic monthly billing.
          </p>
          <button
            type="button"
            onClick={authorise}
            disabled={busy}
            className="rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-60"
          >
            {busy ? 'Starting…' : 'Authorise debit order'}
          </button>
        </div>
      )}

      {!loading && data?.mandate && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            {data.mandate.status === 'active' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600" />
            ) : data.mandate.status === 'pending' ? (
              <Loader2 className="w-5 h-5 text-amber-500 animate-spin" />
            ) : (
              <XCircle className="w-5 h-5 text-rose-600" />
            )}
            <span className="font-medium text-slate-900 capitalize">{data.mandate.status}</span>
          </div>

          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            {data.mandate.bank_name && <Row label="Bank" value={data.mandate.bank_name} />}
            {data.mandate.masked_account_number && (
              <Row label="Account" value={data.mandate.masked_account_number} />
            )}
            <Row
              label="Authorised up to"
              value={formatCurrency(Number(data.mandate.max_amount_cents) / 100)}
            />
            {data.mandate.authorised_at && (
              <Row
                label="Authorised"
                value={new Date(data.mandate.authorised_at).toLocaleDateString('en-ZA')}
              />
            )}
          </dl>

          {data.mandate.status === 'active' && (
            <button
              type="button"
              onClick={revoke}
              disabled={busy}
              className="text-sm text-rose-600 hover:text-rose-700 font-medium disabled:opacity-60"
            >
              Revoke mandate
            </button>
          )}
        </div>
      )}

      {!loading && data && data.charges.length > 0 && (
        <div className="mt-6 border-t border-slate-200 pt-4">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">Recent debits</h3>
          <ul className="space-y-2 text-sm">
            {data.charges.map((c) => (
              <li key={c.id} className="flex items-center justify-between">
                <span className="text-slate-600">
                  {new Date(c.period_start).toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' })}
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-slate-900 font-medium">
                    {formatCurrency(Number(c.amount_cents) / 100)}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLES[c.status]}`}>
                    {c.status}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-900 font-medium text-right">{value}</dd>
    </>
  );
}
