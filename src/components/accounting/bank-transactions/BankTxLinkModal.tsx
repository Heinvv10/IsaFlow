/**
 * Link a bank transaction to an asset — or to one of that asset's fuel / service records — or remove its link
 * (mig 853). Search an asset, pick it, then optionally pick a fuel or service record of it. A link is an
 * annotation only: it never posts, and never changes the line's status or reconciliation.
 */
import { useEffect, useState } from 'react';
import { Loader2, Truck, X } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import type { BankTxLink } from '@/modules/accounting/types/bank.types';
import { loadFuelRecords, loadServiceRecords, type FuelRecord, type ServiceRecord } from '@/components/assets/fleetRecordsApi';

interface LinkableTx { id: string; description?: string; amount: number; transactionDate: string; link?: BankTxLink }
interface Props { tx: LinkableTx; onClose: () => void; onDone: () => void }
interface AssetOption { id: string; name: string; assetNumber: string }
/** `asset` = the asset itself; otherwise a fuel / service record of it. */
type Target = { kind: 'asset' } | { kind: 'fuel' | 'service'; id: string };

const fmtR = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

function toAssets(data: unknown): AssetOption[] {
  if (!Array.isArray(data)) return [];
  return data.map((r: { id?: unknown; name?: unknown; asset_number?: unknown }) => ({
    id: String(r.id), name: String(r.name ?? ''), assetNumber: String(r.asset_number ?? ''),
  }));
}

async function postLink(kind: BankTxLink['kind'], bankTransactionId: string, id: string | null): Promise<void> {
  const url = kind === 'asset' ? '/api/accounting/bank-match-asset' : '/api/accounting/bank-match-fleet';
  const body = kind === 'asset' ? { bankTransactionId, assetId: id } : { bankTransactionId, fleetEntityType: kind, fleetEntityId: id };
  const res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await assertOk(res, id ? 'Could not link the bank transaction - try again' : 'Could not unlink the bank transaction - try again');
}

export function BankTxLinkModal({ tx, onClose, onDone }: Props) {
  const [search, setSearch] = useState('');
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [fuel, setFuel] = useState<FuelRecord[]>([]);
  const [services, setServices] = useState<ServiceRecord[]>([]);
  const [target, setTarget] = useState<Target>({ kind: 'asset' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Each effect ignores a response that arrives after it was superseded (a newer search, another asset picked):
  // a late answer for asset A would otherwise show A's records while B is selected, and link A's record.
  useEffect(() => {
    let ignore = false;
    const term = search.trim();
    const t = setTimeout(() => {
      setAssetsLoading(true);
      void (async () => {
        try {
          const res = await apiFetch(`/api/accounting/assets${term ? `?search=${encodeURIComponent(term)}` : ''}`);
          await assertOk(res, 'Could not load the assets - try again');
          const rows = toAssets(((await res.json()) as { data?: unknown }).data);
          if (!ignore) setAssets(rows);
        } catch (err) {
          if (ignore) return;
          setAssets([]);
          setError(apiErrorMessage(err, 'Could not load the assets - try again'));
        } finally { if (!ignore) setAssetsLoading(false); }
      })();
    }, 250);
    return () => { ignore = true; clearTimeout(t); };
  }, [search]);

  useEffect(() => {
    if (!assetId) { setFuel([]); setServices([]); return; }
    let ignore = false;
    setTarget({ kind: 'asset' });
    setFuel([]); setServices([]);
    void Promise.all([loadFuelRecords(assetId), loadServiceRecords(assetId)])
      .then(([f, s]) => { if (!ignore) { setFuel(f); setServices(s); } })
      .catch((err: unknown) => {
        if (ignore) return;
        setFuel([]); setServices([]);
        setError(apiErrorMessage(err, 'Could not load the fuel and service records - try again'));
      });
    return () => { ignore = true; };
  }, [assetId]);

  const link = async () => {
    if (!assetId) return;
    setBusy(true); setError('');
    try {
      if (target.kind === 'asset') await postLink('asset', tx.id, assetId);
      else await postLink(target.kind, tx.id, target.id);
      notify.success('Bank transaction linked');
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not link the bank transaction - try again'));
    } finally { setBusy(false); }
  };

  const unlink = async () => {
    if (!tx.link) return;
    setBusy(true); setError('');
    try {
      await postLink(tx.link.kind, tx.id, null);
      notify.success('Link removed');
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not unlink the bank transaction - try again'));
    } finally { setBusy(false); }
  };

  const radio = (t: Target, label: string, key: string) => {
    const on = t.kind === target.kind && (t.kind === 'asset' || (target.kind !== 'asset' && t.id === target.id));
    return (
      <label key={key} className="flex items-center gap-2 text-xs text-[var(--ff-text-primary)] py-1 cursor-pointer">
        <input type="radio" name="link-target" checked={on} onChange={() => setTarget(t)} />
        <span className="truncate">{label}</span>
      </label>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-label="Link to asset / fuel / service">
      <div className="w-full max-w-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--ff-border-light)] shrink-0">
          <div className="p-2 rounded-lg bg-sky-500/10"><Truck className="h-4 w-4 text-sky-400" /></div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Link to asset / fuel / service</h2>
            <p className="text-xs text-[var(--ff-text-tertiary)] truncate">{tx.transactionDate} · {fmtR(tx.amount)} · {tx.description ?? ''}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <p className="text-xs text-[var(--ff-text-tertiary)]">A link is a note on this line only. It posts nothing and does not change its allocation or reconciliation.</p>
          {tx.link && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2">
              <span className="text-xs text-sky-300 truncate">Linked: {tx.link.assetName && tx.link.kind !== 'asset' ? `${tx.link.assetName} — ` : ''}{tx.link.label}</span>
              <button onClick={() => void unlink()} disabled={busy} className="text-xs px-2 py-1 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-50">Unlink</button>
            </div>
          )}
          {error && <div className="text-xs text-red-400 bg-red-500/10 rounded px-3 py-2">{error}</div>}

          <div>
            <label htmlFor="link-asset-search" className="block text-xs text-[var(--ff-text-secondary)] mb-1">Asset</label>
            <input id="link-asset-search" className="ff-input w-full" placeholder="Search by name, number or serial" value={search} onChange={e => setSearch(e.target.value)} />
            <div className="mt-2 max-h-40 overflow-y-auto rounded border border-[var(--ff-border-light)]">
              {assetsLoading ? <div className="p-3 flex justify-center"><Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" /></div>
                : assets.length === 0 ? <p className="p-3 text-xs text-[var(--ff-text-tertiary)]">No assets found</p>
                  : assets.map(a => (
                    <button key={a.id} type="button" onClick={() => setAssetId(a.id)}
                      className={`w-full text-left px-3 py-1.5 text-xs ${a.id === assetId ? 'bg-sky-500/15 text-sky-300' : 'text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-primary)]'}`}>
                      {a.name} <span className="text-[var(--ff-text-tertiary)]">{a.assetNumber}</span>
                    </button>
                  ))}
            </div>
          </div>

          {assetId && (
            <div>
              <p className="text-xs text-[var(--ff-text-secondary)] mb-1">Link to</p>
              {radio({ kind: 'asset' }, 'The asset itself', 'asset')}
              {fuel.map(f => radio({ kind: 'fuel', id: f.id }, `Fuel ${f.fillDate} ${fmtR(f.amount)} · ${f.litres} L`, f.id))}
              {services.map(s => radio({ kind: 'service', id: s.id }, `Service ${s.serviceDate} ${fmtR(s.amount)} · ${s.description}`, s.id))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--ff-border-light)] shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)]">Cancel</button>
          <button onClick={() => void link()} disabled={!assetId || busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Link
          </button>
        </div>
      </div>
    </div>
  );
}
