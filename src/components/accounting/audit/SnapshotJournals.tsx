/**
 * A snapshot's frozen journals, paged, each opening onto its frozen lines.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { fmtAmount, fmtAt, getData, type Row } from './auditSnapshotApi';
import { formatDisplayDate } from '@/utils/dateFormat';

interface Stored { id: string; journalId: string; row: Row; materialHash: string; account?: { code: string | null; name: string | null; type: string | null } }
const SIZE = 50;

export function SnapshotJournals({ snapshotId }: { snapshotId: string }) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Stored[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Record<string, Stored[] | 'loading'>>({});

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await getData<{ rows: Stored[]; total: number }>(
        `/api/accounting/audit-snapshots?id=${snapshotId}&section=journals&page=${page}&size=${SIZE}`, 'Could not load the journals - try again');
      setRows(d.rows); setTotal(d.total);
    } catch (err) { setRows([]); setError(apiErrorMessage(err, 'Could not load the journals - try again')); }
  }, [snapshotId, page]);
  useEffect(() => { void load(); }, [load]);

  async function toggle(id: string) {
    if (open[id]) { setOpen((p) => { const n = { ...p }; delete n[id]; return n; }); return; }
    setOpen((p) => ({ ...p, [id]: 'loading' }));
    try {
      const d = await getData<{ rows: Stored[] }>(`/api/accounting/audit-snapshots?id=${snapshotId}&section=lines&journalId=${id}`,
        'Could not load the lines - try again');
      setOpen((p) => ({ ...p, [id]: d.rows }));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the lines - try again'));
      setOpen((p) => { const n = { ...p }; delete n[id]; return n; });
    }
  }

  const pages = Math.max(1, Math.ceil(total / SIZE));
  return (
    <div>
      {error && <p className="text-sm text-red-400 px-4 py-2">{error}</p>}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-[rgba(255,255,255,0.06)]">
            <th className="px-4 py-2" /><th className="px-4 py-2">Number</th><th className="px-4 py-2">Date</th><th className="px-4 py-2">Source</th>
            <th className="px-4 py-2">Description</th><th className="px-4 py-2">Posted</th><th className="px-4 py-2">Row hash</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[rgba(255,255,255,0.04)]">
          {rows.map((j) => (
            <Fragment key={j.id}>
              <tr className="hover:bg-white/5 cursor-pointer" onClick={() => void toggle(j.id)}>
                <td className="px-4 py-2 text-slate-500">{open[j.id] ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                <td className="px-4 py-2 text-slate-200">{j.row.entry_number ?? '—'}</td>
                <td className="px-4 py-2 text-slate-300">{formatDisplayDate(j.row.entry_date)}</td>
                <td className="px-4 py-2 text-slate-400">{j.row.source}</td>
                <td className="px-4 py-2 text-slate-300 max-w-[320px] truncate" title={j.row.description ?? ''}>{j.row.description ?? '—'}</td>
                <td className="px-4 py-2 text-slate-400 text-xs">{fmtAt(j.row.posted_at)}{j.row.reversed_at && <span className="block text-amber-300">reversed {fmtAt(j.row.reversed_at)}</span>}</td>
                <td className="px-4 py-2 font-mono text-xs text-slate-500" title={j.materialHash}>{j.materialHash.slice(0, 10)}…</td>
              </tr>
              {open[j.id] === 'loading' && <tr><td colSpan={7} className="px-10 py-2"><Loader2 className="h-4 w-4 animate-spin text-teal-500" /></td></tr>}
              {Array.isArray(open[j.id]) && (open[j.id] as Stored[]).map((l) => (
                <tr key={l.id} className="bg-black/20 text-xs">
                  <td /><td className="px-4 py-1 text-slate-300" colSpan={2}>{l.account?.code} {l.account?.name} <span className="text-slate-500">{l.account?.type}</span></td>
                  <td className="px-4 py-1 text-right text-slate-300">{l.row.debit !== '0.00' ? `DR ${fmtAmount(l.row.debit)}` : ''}</td>
                  <td className="px-4 py-1 text-slate-300">{l.row.credit !== '0.00' ? `CR ${fmtAmount(l.row.credit)}` : ''} <span className="text-slate-500">{l.row.description}</span></td>
                  <td /><td className="px-4 py-1 font-mono text-slate-600">{l.materialHash.slice(0, 10)}…</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between px-4 py-3 text-xs text-slate-400">
        <span>{total} journals</span>
        <div className="flex items-center gap-2">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-2 py-1 rounded bg-white/5 disabled:opacity-40">Previous</button>
          <span>Page {page} of {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="px-2 py-1 rounded bg-white/5 disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>
  );
}
