/**
 * The reconciliation screen's GL side: every journal line of the session's bank account that a statement line can
 * still be matched to (GET /api/accounting/bank-reconciliation-gl-lines — auto-match's own candidate set), newest
 * first. The list is bounded on the server; when it is cut, the panel says how many lines there are and asks for a
 * search (description, entry number or amount), which runs on the server, instead of showing part as the whole.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import type { ReconGlLine, ReconGlLinesPage } from '@/modules/accounting/services/bank/bankReconcilableGlLines';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { formatDisplayDate } from '@/utils/dateFormat';

const LOAD_FAILED = 'Could not load the bank ledger lines - try again';

export function ReconGlLinesPanel({ reconciliationId, reloadKey, completed, selectedId, onSelect }: {
  reconciliationId: string;
  /** Changes whenever the screen reloads (after a match, unmatch or auto-match): the list is read again. */
  reloadKey: number;
  completed: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [lines, setLines] = useState<ReconGlLine[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Only the newest request writes: a slow answer to an older search must not replace a newer one.
  const seq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // A selection the settled list no longer offers (a search, a reload or a failed load dropped it) is cleared: Match
  // must never send a line the screen is not showing. Judged only once a load has settled, not on the empty first render.
  useEffect(() => {
    if (!loading && selectedId && !lines.some(l => l.id === selectedId)) onSelect(null);
  }, [loading, lines, selectedId, onSelect]);

  useEffect(() => {
    // A completed session has nothing to match: the server answers an empty list for it (fail closed), so it is not read.
    if (!reconciliationId || completed) return;
    const mine = ++seq.current;
    const load = async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ reconciliationId });
        if (search) qs.set('search', search);
        const res = await apiFetch(`/api/accounting/bank-reconciliation-gl-lines?${qs.toString()}`);
        await assertOk(res, LOAD_FAILED);
        const json = await res.json();
        const page = (json.data ?? {}) as Partial<ReconGlLinesPage>;
        if (mine !== seq.current) return;
        setLines(page.lines ?? []);
        setTotal(page.total ?? 0);
        setTruncated(page.truncated === true);
        setError('');
      } catch (err) {
        if (mine !== seq.current) return;
        setLines([]); setTotal(0); setTruncated(false);
        setError(apiErrorMessage(err, LOAD_FAILED));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    };
    void load();
  }, [reconciliationId, reloadKey, search, completed]);

  if (completed) {
    return (
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
        <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">GL Lines</h3>
        </div>
        <p className="p-4 text-sm text-[var(--ff-text-tertiary)]">Reconciliation completed — no lines to match</p>
      </div>
    );
  }

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
      <div className="px-4 py-3 border-b border-[var(--ff-border-light)] space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">
            GL Lines ({total} unmatched{search ? ' matching the search' : ''})
          </h3>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-teal-500" />}
        </div>
        <label className="flex items-center gap-2">
          <Search className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
          <input
            className="ff-input w-full text-sm"
            placeholder="Search description, entry number or amount (1234.50)"
            aria-label="Search GL lines"
            value={searchInput}
            maxLength={100}
            onChange={e => setSearchInput(e.target.value)}
          />
        </label>
        {truncated && (
          <p className="text-xs text-amber-500" role="status">
            Showing the newest {lines.length} of {total} lines. Search to find an older one.
          </p>
        )}
      </div>
      <div className="max-h-[500px] overflow-y-auto">
        {error ? (
          <p className="p-4 text-sm text-red-400">{error}</p>
        ) : lines.length === 0 ? (
          <p className="p-4 text-sm text-[var(--ff-text-tertiary)]">
            {loading ? 'Loading GL lines…' : search ? 'No unmatched GL lines match the search' : 'No unmatched GL lines'}
          </p>
        ) : (
          <div className="divide-y divide-[var(--ff-border-light)]">
            {lines.map(line => {
              const amount = line.debit > 0 ? line.debit : -line.credit;
              return (
                <div
                  key={line.id}
                  onClick={() => !completed && onSelect(line.id === selectedId ? null : line.id)}
                  className={`px-4 py-2 text-sm cursor-pointer transition-colors ${
                    selectedId === line.id ? 'bg-blue-500/10' : 'hover:bg-[var(--ff-bg-primary)]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-[var(--ff-text-primary)] truncate">{line.description || '—'}</p>
                      <p className="text-xs text-[var(--ff-text-tertiary)]">
                        {line.entryNumber} | {formatDisplayDate(line.entryDate)}
                      </p>
                    </div>
                    <span className={`tabular-nums text-sm ml-2 ${amount >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                      {formatCurrency(amount)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
