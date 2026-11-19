/**
 * /accounting/settings/intercompany/pairing — Settings > Intercompany pairing (P3).
 * Before a connection's cut-over date, link the documents that are already open on both sides: this company's open invoices
 * against the partner's open bills (or the reverse), suggested by number and amount, confirmed by a person. A pairing only records
 * that two documents are the same invoice; nothing is posted. What cannot be paired is listed as an exception, and the two
 * companies' intercompany loan balances are compared.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { LoanDifferenceCard } from '@/components/accounting/intercompany/pairing/LoanDifferenceCard';
import { PairingExceptions } from '@/components/accounting/intercompany/pairing/PairingExceptions';
import { PairingLinks } from '@/components/accounting/intercompany/pairing/PairingLinks';
import { PairingSuggestions } from '@/components/accounting/intercompany/pairing/PairingSuggestions';
import { useCompany } from '@/contexts/CompanyContext';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { canWrite } from '@/lib/auth/writeRoles';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';
import { formatDate } from '@/utils/formatters';
import type { ConnectionView } from '@/modules/accounting/services/intercompany/connectionTypes';
import type { PairingBlock, PairingDirection, PairingView } from '@/modules/accounting/services/intercompany/pairingTypes';

const BLOCK_TEXT: Record<PairingBlock, string> = {
  revoked: 'This connection is revoked, so nothing new can be paired. Existing pairings are listed below.',
  no_write_access: 'Pairing needs an owner, admin or manager role in this company. You can see the pairings already made.',
  no_cutover: "Set the connection's cut-over date first: only documents dated before it are paired.",
  no_party: 'Link the customer (for your invoices) or the supplier (for your bills) on this connection first.',
};
const TAB = 'px-4 py-2 text-sm font-medium border-b-2 -mb-px';

export default function IntercompanyPairingPage() {
  const router = useRouter();
  const mayWrite = canWrite(useCompany().companyRole);
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [direction, setDirection] = useState<PairingDirection>('ar');
  const [view, setView] = useState<PairingView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);
  const afterDelay = useTimeoutOnce();
  // Only the newest load may write state: a slow earlier answer must not replace a newer one.
  const latest = useRef(0);

  const say = useCallback((msg: string, ok: boolean) => { setNotice({ msg, ok }); afterDelay(() => setNotice(null), 6000); }, [afterDelay]);

  useEffect(() => {
    let cancelled = false;
    apiJson('/api/accounting/intercompany/connections', undefined, 'Could not load your intercompany connections - try again')
      .then((list) => {
        if (cancelled) return;
        if (!('items' in list)) throw new Error('unexpected reply');
        const live = list.items.filter((c) => c.status === 'active');
        setConnections(live);
        const wanted = typeof router.query.connection === 'string' ? router.query.connection : '';
        setConnectionId(live.find((c) => c.id === wanted)?.id ?? live[0]?.id ?? '');
        if (live.length === 0) setLoading(false);
      })
      .catch((err) => { if (!cancelled) { setLoadError(apiErrorMessage(err, 'Could not load your intercompany connections - try again')); setLoading(false); } });
    return () => { cancelled = true; };
  // The query is read once, on arrival; choosing another connection afterwards is the select's job.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!connectionId) return;
    const mine = ++latest.current;
    setLoading(true);
    try {
      const res = await apiJson(`/api/accounting/intercompany/connections/${connectionId}/pairing?direction=${direction}`, undefined,
        'Could not load the pairing screen - try again');
      if (mine !== latest.current) return;
      if (!('matches' in res)) throw new Error('unexpected reply');
      setView(res);
      setLoadError('');
    } catch (err) {
      if (mine !== latest.current) return;
      setLoadError(apiErrorMessage(err, 'Could not load the pairing screen - try again'));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [connectionId, direction]);

  useEffect(() => { void load(); }, [load]);

  const done = (message: string) => { say(message, true); void load(); };
  const current = connections?.find((c) => c.id === connectionId);
  const partner = view?.partnerName ?? current?.partnerName ?? 'the partner';
  const nothingLeft = view && !view.blocked && view.matches.suggestions.length === 0 && view.matches.mismatches.length === 0
    && view.matches.unmatchedMine.length === 0 && view.matches.unmatchedTheirs.length === 0 && view.matches.unsupported.length === 0;

  return (
    <AppLayout>
      {notice && (
        <div role="alert" className={`fixed top-4 right-4 z-50 max-w-sm px-4 py-3 rounded-lg shadow-lg border flex items-start gap-2 ${
          notice.ok ? 'bg-emerald-900/90 border-emerald-700 text-emerald-100' : 'bg-red-900/90 border-red-700 text-red-100'}`}>
          <span className="flex-1 text-sm">{notice.msg}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="opacity-70 hover:opacity-100"><X className="h-4 w-4" /></button>
        </div>
      )}
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--ff-text-primary)]">Intercompany pairing</h1>
          <p className="text-sm text-ink-muted mt-1">
            Before the cut-over date, link the invoices that are already open on both sides so later payments can be matched. A pairing
            only records that your document and the partner&apos;s are the same invoice: nothing is posted and no balance changes.
          </p>
        </div>

        {loadError && (
          <div role="alert" className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
            <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden /><span className="flex-1">{loadError}</span>
            <button type="button" onClick={() => void load()} className="underline">Try again</button>
          </div>
        )}

        {connections !== null && connections.length === 0 && !loadError && (
          <div className="text-center py-10 space-y-2" data-testid="no-live-connections">
            <p className="text-sm text-[var(--ff-text-primary)]">There is no active intercompany connection to pair documents on.</p>
            <Link href="/accounting/settings/intercompany" className="text-sm text-blue-600 dark:text-blue-400 underline">Set up a connection</Link>
          </div>
        )}

        {connections !== null && connections.length > 0 && (
          <>
            <div className="flex flex-wrap items-end gap-4">
              <div className="min-w-[16rem]">
                <label htmlFor="ic-pair-connection" className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Connection</label>
                <select id="ic-pair-connection" className="ff-input w-full text-sm" value={connectionId}
                  onChange={(e) => { setView(null); setConnectionId(e.target.value); }}>
                  {connections.map((c) => <option key={c.id} value={c.id}>{c.partnerName}</option>)}
                </select>
              </div>
              {view?.cutoverDate && (
                <p className="text-sm text-ink-muted pb-2" data-testid="cutover">Cut-over: <strong className="text-[var(--ff-text-primary)]">{formatDate(view.cutoverDate)}</strong>. Documents dated before it are paired.</p>
              )}
            </div>

            <div role="tablist" aria-label="Which documents to pair" className="flex gap-1 border-b border-[var(--ff-border-light)]">
              {([['ar', `Owed to you: your invoices to ${partner}`], ['ap', `Owed by you: ${partner}'s invoices to you`]] as const).map(([key, label]) => (
                <button key={key} type="button" role="tab" aria-selected={direction === key} onClick={() => { setView(null); setDirection(key); }}
                  className={`${TAB} ${direction === key ? 'border-blue-500 text-[var(--ff-text-primary)]' : 'border-transparent text-ink-muted hover:text-[var(--ff-text-primary)]'}`}>
                  {label}
                </button>
              ))}
            </div>

            {loading && !view && <div className="flex items-center gap-2 text-ink-muted py-3"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /><span className="text-sm">Loading…</span></div>}

            {view && (
              <div className="space-y-6" aria-busy={loading} data-testid="pairing-view" data-blocked={view.blocked ?? ''}>
                {loading && <p className="flex items-center gap-2 text-xs text-ink-muted" role="status"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />Refreshing…</p>}
                {view.blocked && (
                  <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/10 text-sm text-amber-800 dark:text-amber-300 space-y-1" role="status" data-testid="blocked">
                    <p>{BLOCK_TEXT[view.blocked]}</p>
                    {(view.blocked === 'no_cutover' || view.blocked === 'no_party') && (
                      <Link href="/accounting/settings/intercompany" className="underline">Go to the connection</Link>
                    )}
                  </div>
                )}
                {view.truncated && (
                  <p className="text-xs text-amber-700 dark:text-amber-400" role="status">Very long lists are cut at 2 000 documents a side; pair these, then reload for the rest.</p>
                )}
                <PairingLinks connectionId={view.connectionId} partnerName={view.partnerName} direction={direction} links={view.links}
                  canWrite={mayWrite} onChanged={done} onError={(m) => say(m, false)} />
                {!view.blocked && (
                  <>
                    <PairingSuggestions connectionId={view.connectionId} direction={direction} partnerName={view.partnerName}
                      suggestions={view.matches.suggestions} confirmsBoth={view.confirmsBoth} onDone={done} onError={(m) => say(m, false)} />
                    {nothingLeft ? (
                      <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400" data-testid="all-paired">
                        <CheckCircle2 className="h-4 w-4" aria-hidden />
                        {view.links.length > 0
                          ? 'Every open document dated before the cut-over is paired.'
                          : `No open documents dated before the cut-over for ${view.partnerName}. If you expected some, check that both companies linked the right ${direction === 'ar' ? 'customer and supplier' : 'supplier and customer'} on the connection.`}
                      </p>
                    ) : (
                      <PairingExceptions matches={view.matches} partnerName={view.partnerName} direction={direction} />
                    )}
                  </>
                )}
                {view.loan && <LoanDifferenceCard loan={view.loan} partnerName={view.partnerName} />}
              </div>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
