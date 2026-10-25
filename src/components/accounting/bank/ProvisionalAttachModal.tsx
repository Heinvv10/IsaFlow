/**
 * The provisional page's "Select captured document" modal: lists the captured documents the evidence attach accepts
 * (`document-capture?attachable=1`), 50 at a time, with "Load more" while the server reports more. Load more pages by
 * keyset (`after` = the server's cursor for the last row), not by offset: a document attached or posted elsewhere
 * between two loads must not shift a row out of the next page.
 * Mounted when opened and unmounted on close, so every open starts from a fresh load.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { formatDate, formatRandAbs } from '@/utils/formatters';
import { AlertCircle, Loader2, X } from 'lucide-react';

interface CapturedDoc {
  id: string; fileName: string; vendorName: string | null;
  documentDate: string | null; totalAmount: number | null; documentType: string | null;
}

const PAGE_SIZE = 50;
const LOAD_ERROR = 'Could not load documents - try again';

export function ProvisionalAttachModal({ submitting, onSelect, onClose }: {
  submitting: boolean; onSelect: (capturedDocumentId: string) => void; onClose: () => void;
}) {
  const [docs, setDocs] = useState<CapturedDoc[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [moreError, setMoreError] = useState('');

  const fetchPage = useCallback(async (after: string | null) => {
    const cursor = after ? `&after=${encodeURIComponent(after)}` : '';
    const res = await apiFetch(`/api/accounting/document-capture?attachable=1&pageSize=${PAGE_SIZE}${cursor}`);
    await assertOk(res, LOAD_ERROR);
    return await res.json() as { data?: CapturedDoc[]; pagination?: { total?: number }; meta?: { nextAfter?: string | null } };
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const json = await fetchPage(null);
        if (!live) return;
        setDocs(json.data ?? []); setTotal(json.pagination?.total ?? null); setNextAfter(json.meta?.nextAfter ?? null);
      } catch (err) {
        if (!live) return;
        log.error('Failed to load captured documents', { error: err }, 'provisional-ui');
        // Shown in place of the empty state (D8 round 14): a failed load is not "no documents".
        setDocs([]); setError(apiErrorMessage(err, LOAD_ERROR));
      } finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [fetchPage]);

  const loadMore = async () => {
    setLoadingMore(true); setMoreError('');
    try {
      const json = await fetchPage(nextAfter);
      const next = json.data ?? [];
      const seen = new Set(docs.map((d) => d.id));
      const fresh = next.filter((d) => !seen.has(d.id));
      setDocs([...docs, ...fresh]);
      // A page with nothing new ends the list, whatever the total said: no endless "Load more".
      setTotal(fresh.length === 0 ? docs.length : json.pagination?.total ?? null);
      setNextAfter(json.meta?.nextAfter ?? null);
    } catch (err) {
      log.error('Failed to load more captured documents', { error: err }, 'provisional-ui');
      setMoreError(apiErrorMessage(err, LOAD_ERROR));
    } finally { setLoadingMore(false); }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--ff-border-light)]">
          <h2 className="font-semibold text-[var(--ff-text-primary)]">Select captured document</h2>
          <button onClick={onClose} className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"><X className="h-5 w-5" /></button>
        </div>
        <div className="px-5 py-3 max-h-96 overflow-y-auto">
          {loading ? <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-teal-400" /></div>
            : error ? <p className="flex items-center justify-center gap-2 text-sm text-red-400 py-8"><AlertCircle className="h-4 w-4 shrink-0" />{error}</p>
            : docs.length === 0 ? <p className="text-sm text-[var(--ff-text-secondary)] text-center py-8">No documents to attach. Upload the slip or invoice in Document Capture first.</p>
            : <>
              {docs.map(d => (
                <button key={d.id} onClick={() => onSelect(d.id)} disabled={submitting}
                  className="w-full text-left flex items-center justify-between p-3 rounded-lg hover:bg-white/5 transition-colors border border-transparent hover:border-[var(--ff-border-light)] mb-1 disabled:opacity-50">
                  <div>
                    <p className="text-sm font-medium text-[var(--ff-text-primary)]">{d.vendorName ?? d.fileName}</p>
                    <p className="text-xs text-[var(--ff-text-tertiary)]">{d.documentType ?? 'Unknown type'} · {formatDate(d.documentDate)}</p>
                  </div>
                  <span className="text-xs tabular-nums text-[var(--ff-text-secondary)] shrink-0 ml-2">{d.totalAmount != null ? formatRandAbs(d.totalAmount) : '—'}</span>
                </button>
              ))}
              {moreError && <p className="flex items-center justify-center gap-2 text-sm text-red-400 py-2"><AlertCircle className="h-4 w-4 shrink-0" />{moreError}</p>}
              {total !== null && nextAfter && docs.length < total && (
                <button onClick={() => void loadMore()} disabled={loadingMore}
                  className="w-full mt-1 px-3 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] hover:bg-white/5 disabled:opacity-50">
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              )}
            </>}
        </div>
        <div className="px-5 py-3 border-t border-[var(--ff-border-light)] flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">Cancel</button>
        </div>
      </div>
    </div>
  );
}
