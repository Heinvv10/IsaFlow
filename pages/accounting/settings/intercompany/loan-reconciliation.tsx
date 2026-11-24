/**
 * /accounting/settings/intercompany/loan-reconciliation — Settings > Intercompany > Loan reconciliation (P5, READ ONLY; plan
 * docs/plans/2026-11-24-intercompany-p5-reconciliation.md). Pick one of this company's loan connections and see, as at today: both companies'
 * loan balances (the partner's only with its consent: flag on, still a group partner, its loan account set up for this connection only), the
 * difference split into named components, what is Unexplained, and three lists (Accepted, then undone; Needs attention; Mismatches). There
 * is no date to choose and nothing to press: the report posts, repairs and sends nothing. Behind the dark flag `intercompany_loan_clearing`
 * (the nav hides the link; the API refuses on its own).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { AlertCircle, Loader2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ReconSummaryCard } from '@/components/accounting/intercompany/recon/ReconSummaryCard';
import { ReconSection } from '@/components/accounting/intercompany/recon/ReconSection';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { DEFAULT_LIMIT, type ReconConnection, type ReconReport, type SectionKey } from '@/modules/accounting/services/intercompany/loanReconTypes';

const BASE = '/api/accounting/intercompany/loan-reconciliation';

export default function IntercompanyLoanReconciliationPage() {
  const router = useRouter();
  const [connections, setConnections] = useState<ReconConnection[] | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [section, setSection] = useState<SectionKey>('undone');
  const [offset, setOffset] = useState(0);
  const [report, setReport] = useState<ReconReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Only the newest load may write state: a slow earlier answer must not replace a newer one.
  const latest = useRef(0);
  const wanted = useRef<string | null>(null);

  const queryConnection = router.query.connection;
  useEffect(() => {
    if (!router.isReady || wanted.current !== null) return;
    wanted.current = typeof queryConnection === 'string' ? queryConnection : '';
    (async () => {
      try {
        const list = (await apiJson(BASE, undefined, 'Could not load your intercompany connections - try again')).connections;
        setConnections(list);
        setConnectionId(list.find((c) => c.id === wanted.current)?.id ?? list[0]?.id ?? '');
        if (list.length === 0) setLoading(false);
      } catch (err) {
        setError(apiErrorMessage(err, 'Could not load your intercompany connections - try again'));
        setLoading(false);
      }
    })();
  }, [router.isReady, queryConnection]);

  const load = useCallback(async () => {
    if (!connectionId) return;
    const mine = ++latest.current;
    setLoading(true);
    try {
      const q = new URLSearchParams({ section, limit: String(DEFAULT_LIMIT), offset: String(offset) });
      const res = await apiJson(`${BASE}/${connectionId}?${q.toString()}`, undefined, 'Could not load the reconciliation - try again');
      if (mine !== latest.current) return;
      setReport(res);
      setError('');
    } catch (err) {
      if (mine !== latest.current) return;
      setReport(null);
      setError(apiErrorMessage(err, 'Could not load the reconciliation - try again'));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [connectionId, section, offset]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppLayout>
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Intercompany loan reconciliation</h1>
          <p className="text-sm text-ink-muted">
            Both companies&apos; intercompany loan balances as at today and what explains the difference. Read only: nothing here posts or changes anything.
          </p>
        </header>
        {connections !== null && connections.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor="ic-recon-connection" className="text-sm font-medium">Connection</label>
            <select id="ic-recon-connection" value={connectionId} className="rounded border border-[var(--ff-border-light)] bg-transparent px-2 py-1 text-sm"
              onChange={(e) => { setConnectionId(e.target.value); setOffset(0); }}>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.partnerName}{c.status !== 'active' ? ` (${c.status})` : ''}</option>)}
            </select>
          </div>
        )}
        {connections !== null && connections.length === 0 && !error && (
          <p className="text-sm">This company has no intercompany loan connection to reconcile.</p>
        )}
        {error && <p role="alert" className="flex items-center gap-2 text-sm text-red-700"><AlertCircle className="h-4 w-4" />{error}</p>}
        {loading && <p className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>}
        {report && !error && (
          <>
            <ReconSummaryCard summary={report.summary} asOf={report.asOf} readAt={report.readAt} partnerName={report.partnerName} />
            <ReconSection report={report} onSection={(k) => { setSection(k); setOffset(0); }} onPage={setOffset} />
          </>
        )}
      </div>
    </AppLayout>
  );
}
