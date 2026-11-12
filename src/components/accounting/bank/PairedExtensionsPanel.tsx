/**
 * Paired browser extensions, shown on Statement Imports (#1285 follow-up).
 * A pairing token lives 90 days and the pairing screen is gone, so this is where a company sees the
 * extensions still able to post transactions and revokes one. GET /api/accounting/bank-feeds is
 * company-scoped (withAuth); revoke is its DELETE, a soft-delete that sets is_active = false, which
 * withExtensionToken checks on every ingest. Renders nothing when there is nothing to revoke or the
 * member may not list connections (the routes are withWriteAccess: 403 for read-only roles).
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiFetch, apiErrorMessage, assertOk, ApiRequestError } from '@/lib/apiFetch';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { formatDisplayDate, formatDisplayDateTime } from '@/utils/dateFormat';

const LIST_URL = '/api/accounting/bank-feeds';
const LOAD_FAILED = 'Could not load the paired browser extensions - try again';
const REVOKE_FAILED = 'Could not revoke the browser extension - try again';

interface Connection {
  id: string;
  provider: string;
  accountName: string | null;
  accountNumberMasked: string | null;
  externalAccountId: string | null;
  status: 'active' | 'paused' | 'error' | 'disconnected';
  lastSyncAt: string | null;
  lastSyncStatus: 'running' | 'success' | 'failed' | null;
  createdAt: string;
}

type Notice = { msg: string; kind: 'ok' | 'err' } | null;

/** The API sends pg timestamps through String(Date), which the shared formatter does not read; Date does. */
function toDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function accountLabel(c: Connection): string {
  return c.accountName ?? 'Unnamed bank account';
}

function accountNumber(c: Connection): string | null {
  if (c.accountNumberMasked) return c.accountNumberMasked;
  const ext = c.externalAccountId;
  return ext && ext.length >= 4 ? `••••${ext.slice(-4)}` : null;
}

function statusLabel(c: Connection): string {
  if (c.lastSyncStatus === 'failed') return 'Last import failed';
  if (c.status === 'paused') return 'Paused';
  if (c.status === 'error') return 'Connection error';
  return 'Active';
}

const TH = 'px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-[var(--ff-text-tertiary)]';
const TD = 'px-4 py-2.5 text-xs text-[var(--ff-text-secondary)]';

export function PairedExtensionsPanel() {
  const [items, setItems] = useState<Connection[]>([]);
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState<Connection | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await apiFetch(LIST_URL);
      await assertOk(res, LOAD_FAILED);
      const json = await res.json() as { data?: { items?: Connection[] } };
      const all = Array.isArray(json.data?.items) ? json.data.items : [];
      setItems(all.filter((c) => c.provider === 'extension'));
    } catch (err) {
      setItems([]);
      // A read-only member may not list connections, and so has nothing here to revoke.
      if (err instanceof ApiRequestError && err.status === 403) return;
      setLoadError(apiErrorMessage(err, LOAD_FAILED));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (c: Connection) => {
    setRevoking(true);
    try {
      await assertOk(await apiFetch(`${LIST_URL}/${c.id}`, { method: 'DELETE' }), REVOKE_FAILED);
      setNotice({ msg: 'Revoked. That browser extension can no longer send transactions.', kind: 'ok' });
      await load();
    } catch (err) {
      setNotice({ msg: apiErrorMessage(err, REVOKE_FAILED), kind: 'err' });
    } finally {
      setRevoking(false);
      setPending(null);
    }
  };

  if (!loadError && items.length === 0 && !notice) return null;

  return (
    <section aria-labelledby="paired-extensions-heading" className="mb-6">
      <h2 id="paired-extensions-heading" className="text-sm font-semibold text-[var(--ff-text-primary)]">Paired browser extensions</h2>
      <p className="text-xs text-[var(--ff-text-secondary)] mt-1 mb-3">
        These browser extensions were paired to a bank account and can still send transactions to IsaFlow. Revoke any you no longer use.
      </p>
      {loadError && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-900/30 text-red-400 text-sm mb-3">
          <AlertCircle className="h-4 w-4 shrink-0" />{loadError}
        </div>
      )}
      {notice && (
        <div role="status" className={`flex items-center gap-2 p-3 rounded-lg text-sm mb-3 ${notice.kind === 'ok' ? 'bg-teal-900/30 text-teal-300' : 'bg-red-900/30 text-red-400'}`}>
          {notice.kind === 'ok' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
          {notice.msg}
        </div>
      )}
      {items.length > 0 && (
        <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="border-b border-[var(--ff-border-light)]">
                <th className={TH}>Bank account</th>
                <th className={TH}>Paired</th>
                <th className={TH}>Last import</th>
                <th className={TH}>Status</th>
                <th className={TH}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const number = accountNumber(c);
                const synced = toDate(c.lastSyncAt);
                const failed = c.lastSyncStatus === 'failed';
                return (
                  <tr key={c.id} className="border-b border-[var(--ff-border-light)] last:border-0">
                    <td className="px-4 py-2.5 text-xs font-medium text-[var(--ff-text-primary)]">
                      {accountLabel(c)}{number && <span className="ml-2 font-id text-[var(--ff-text-tertiary)]">{number}</span>}
                    </td>
                    <td className={`${TD} tabular-nums`}>{formatDisplayDate(toDate(c.createdAt))}</td>
                    <td className={`${TD} tabular-nums`}>{synced ? formatDisplayDateTime(synced) : 'Never'}</td>
                    <td className={`${TD} ${failed ? 'text-amber-400' : ''}`}>{statusLabel(c)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        aria-label={`Revoke ${accountLabel(c)}`}
                        onClick={() => { setNotice(null); setPending(c); }}
                        className="px-3 py-1 rounded-md text-xs font-medium border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={pending !== null}
        title="Revoke this browser extension?"
        message={<>The browser extension paired to <strong>{pending ? accountLabel(pending) : ''}</strong> will stop sending transactions to IsaFlow straight away. Transactions it already imported stay where they are. This cannot be undone.</>}
        acceptLabel={revoking ? 'Revoking...' : 'Revoke'}
        cancelLabel="Keep it"
        tone="destructive"
        loading={revoking}
        onAccept={() => { if (pending) void revoke(pending); }}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}
