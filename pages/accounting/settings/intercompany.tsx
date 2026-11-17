/**
 * /accounting/settings/intercompany — Settings > Intercompany > Connections (P1).
 * Connect this company to another company of its group, set up this company's own side of each connection
 * (customer, supplier, settlement, accounts, cut-over date) and see what is still to do. Nothing is exchanged
 * between the companies yet; that arrives in later phases.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ConnectionCard } from '@/components/accounting/intercompany/ConnectionCard';
import { NewConnectionPanel } from '@/components/accounting/intercompany/NewConnectionPanel';
import { useCompany } from '@/contexts/CompanyContext';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { canWrite } from '@/lib/auth/writeRoles';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';
import type { ConnectionView, GroupCandidate, SideOptions } from '@/modules/accounting/services/intercompany/connectionTypes';

const NO_OPTIONS: SideOptions = { customers: [], suppliers: [], accounts: [], truncated: false };

export default function IntercompanyConnectionsPage() {
  const mayWrite = canWrite(useCompany().companyRole);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [candidates, setCandidates] = useState<GroupCandidate[]>([]);
  const [options, setOptions] = useState<SideOptions>(NO_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);
  const afterDelay = useTimeoutOnce();

  const say = useCallback((msg: string, ok: boolean) => {
    setNotice({ msg, ok });
    afterDelay(() => setNotice(null), 5000);
  }, [afterDelay]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [list, group, pick] = await Promise.all([
        apiJson('/api/accounting/intercompany/connections', undefined, 'Could not load your intercompany connections - try again'),
        apiJson('/api/accounting/intercompany/group-candidates', undefined, 'Could not load your group companies - try again'),
        apiJson('/api/accounting/intercompany/side-options', undefined, 'Could not load your customers and accounts - try again'),
      ]);
      if (!('items' in list)) throw new Error('unexpected reply');
      setConnections(list.items);
      setCandidates(group.items);
      setOptions(pick);
    } catch (err) {
      setConnections([]);
      setCandidates([]);
      setOptions(NO_OPTIONS);
      setLoadError(apiErrorMessage(err, 'Could not load your intercompany connections - try again'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refresh = useCallback(() => { void load(); }, [load]);

  // A saved or revoked connection replaces its own card; revoking also frees its company to be reconnected.
  const replace = useCallback(async (updated: ConnectionView) => {
    setConnections((list) => list.map((c) => (c.id === updated.id ? updated : c)));
    try {
      const group = await apiJson('/api/accounting/intercompany/group-candidates', undefined, 'Could not refresh your group companies - reload the page');
      setCandidates(group.items);
    } catch (err) {
      say(apiErrorMessage(err, 'Could not refresh your group companies - reload the page'), false);
    }
  }, [say]);

  return (
    <AppLayout>
      {notice && (
        <div role="alert" className={`fixed top-4 right-4 z-50 max-w-sm px-4 py-3 rounded-lg shadow-lg border flex items-start gap-2 ${
          notice.ok ? 'bg-emerald-900/90 border-emerald-700 text-emerald-100' : 'bg-red-900/90 border-red-700 text-red-100'}`}>
          <span className="flex-1 text-sm">{notice.msg}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="opacity-70 hover:opacity-100"><X className="h-4 w-4" /></button>
        </div>
      )}
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--ff-text-primary)]">Intercompany connections</h1>
          <p className="text-sm text-ink-muted mt-1">
            Link this company to another company in your group so invoices between them can be mirrored instead of captured twice.
            You set up your own side only; the other company sets up its own.
          </p>
        </div>

        {loadError && (
          <div role="alert" className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
            <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden />
            <span className="flex-1">{loadError}</span>
            <button type="button" onClick={refresh} className="underline">Try again</button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-ink-muted py-3"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /><span className="text-sm">Loading…</span></div>
        ) : !loadError && (
          <>
            {options.truncated && (
              <p className="text-xs text-amber-700 dark:text-amber-400" role="status">
                Very long lists are cut at 5 000 entries here; a customer, supplier or account further down will not be offered.
              </p>
            )}
            {mayWrite && <NewConnectionPanel candidates={candidates} onCreated={refresh} onNotice={say} />}
            {connections.length === 0 ? (
              <p className="text-sm text-ink-muted" data-testid="no-connections">No intercompany connections yet.</p>
            ) : (
              connections.map((c) => (
                <ConnectionCard key={c.id} connection={c} options={options} canEdit={mayWrite} onChanged={(u) => void replace(u)} onNotice={say} />
              ))
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
