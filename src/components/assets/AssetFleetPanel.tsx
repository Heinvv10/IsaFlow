/**
 * The asset page's fleet panel (mig 853): Fuel and Service tabs (list / add / delete) and the bank transactions
 * linked to the asset or to any of its records. Links are made on the bank transactions screen.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Fuel, Landmark, Loader2, Wrench } from 'lucide-react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { FleetRecordsTab } from './FleetRecordsTab';
import { loadAssetBankLinks, type AssetBankLine } from './fleetRecordsApi';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';

type Tab = 'fuel' | 'service' | 'bank';
const fmtR = (n: number) => formatMoney(n);

function LinkedBankTransactions({ assetId, version }: { assetId: string; version: number }) {
  const [rows, setRows] = useState<AssetBankLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRows(await loadAssetBankLinks(assetId)); } catch (err) {
      setRows([]);
      setError(apiErrorMessage(err, 'Could not load the linked bank transactions - try again'));
    } finally { setLoading(false); }
  }, [assetId]);

  useEffect(() => { void load(); }, [load, version]);

  if (loading) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-blue-500" /></div>;
  if (error) return <div className="text-xs text-red-400 bg-red-500/10 rounded px-3 py-2">{error}</div>;
  if (rows.length === 0) {
    return <p className="text-xs text-[var(--ff-text-tertiary)] py-4 text-center">No bank transactions linked. Link one from Banking → Bank Transactions.</p>;
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-[var(--ff-text-secondary)] uppercase border-b border-[var(--ff-border-light)]">
          <th className="px-2 py-1.5 text-left">Date</th>
          <th className="px-2 py-1.5 text-left">Bank</th>
          <th className="px-2 py-1.5 text-left">Description</th>
          <th className="px-2 py-1.5 text-right">Amount</th>
          <th className="px-2 py-1.5 text-left">Linked to</th>
          <th className="px-2 py-1.5 text-left">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.id} className="border-b border-[var(--ff-border-light)] text-[var(--ff-text-primary)]">
            <td className="px-2 py-1.5">{formatDisplayDate(r.transactionDate, '')}</td>
            <td className="px-2 py-1.5">
              <Link href={`/accounting/bank-transactions?account_id=${encodeURIComponent(r.bankAccountId)}`} className="text-blue-400 hover:text-blue-300">
                {r.bankAccountName ?? 'Bank account'}
              </Link>
            </td>
            <td className="px-2 py-1.5 truncate max-w-[240px]">{r.description ?? '—'}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtR(r.amount)}</td>
            <td className="px-2 py-1.5">{r.kind === 'asset' ? 'Asset' : r.link.label}</td>
            <td className="px-2 py-1.5 capitalize">{r.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AssetFleetPanel({ assetId }: { assetId: string }) {
  const [tab, setTab] = useState<Tab>('fuel');
  const [version, setVersion] = useState(0);
  const tabs: { id: Tab; label: string; icon: typeof Fuel }[] = [
    { id: 'fuel', label: 'Fuel', icon: Fuel },
    { id: 'service', label: 'Service', icon: Wrench },
    { id: 'bank', label: 'Linked bank transactions', icon: Landmark },
  ];
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
      <div role="tablist" aria-label="Fleet records" className="flex gap-1 px-3 pt-2 border-b border-[var(--ff-border-light)]">
        {tabs.map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px ${tab === t.id
              ? 'border-blue-500 text-blue-400' : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>
            <t.icon className="h-3.5 w-3.5" /> {t.label}
          </button>
        ))}
      </div>
      <div className="p-4" role="tabpanel">
        {tab === 'bank'
          ? <LinkedBankTransactions assetId={assetId} version={version} />
          : <FleetRecordsTab key={tab} assetId={assetId} kind={tab} onChanged={() => setVersion(v => v + 1)} />}
      </div>
    </div>
  );
}
