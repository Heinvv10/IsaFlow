/**
 * "Link tax invoice" — VAT-gaps batch item 1 (migration 706,
 * gl/journalDocumentLinkService). Lets a manual/recurring/Sage-GL-import/
 * migration journal — none of which can carry `source_document_id` — pick a
 * captured document of the company as its evidence. Clears the journal from
 * the pre-filing "unsupported input VAT" list; unlinking restores the block.
 *
 * Used on the journal detail page and from the unsupported-input-VAT section
 * of the exceptions panel (VatInputSupportSections.tsx).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link2, Loader2, Unlink } from 'lucide-react';
import { apiFetch, ApiRequestError, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface LinkableDocument {
  id: string;
  fileName: string;
  documentType: string | null;
}

interface ActiveLink {
  id: string;
  capturedDocumentId: string;
}

interface Props {
  journalEntryId: string;
  onChanged?: () => void;
}

export function LinkTaxInvoiceButton({ journalEntryId, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<ActiveLink[]>([]);
  const [candidates, setCandidates] = useState<LinkableDocument[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/accounting/journal-document-links?journal_entry_id=${journalEntryId}`);
    if (!res.ok) return;
    const body = await res.json();
    const data = body.data ?? body;
    setLinks(data.links ?? []);
    setCandidates(data.candidates ?? []);
    setSelectedId((data.candidates ?? [])[0]?.id ?? '');
  }, [journalEntryId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const link = async () => {
    if (!selectedId) return;
    const reason = window.prompt('Why does this document back this journal\'s VAT claim?');
    if (!reason || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/journal-document-links', {
        method: 'POST',
        body: JSON.stringify({
          action: 'link', journalEntryId, capturedDocumentId: selectedId, reason: reason.trim(),
        }),
      });
      await assertOk(res, 'Could not link this document');
      setOpen(false);
      onChanged?.();
    } catch (err) {
      log.warn('LinkTaxInvoiceButton: link failed', { error: err }, 'LinkTaxInvoiceButton');
      setError(err instanceof ApiRequestError ? err.message : 'Could not link this document');
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (capturedDocumentId: string) => {
    const reason = window.prompt('Why is this document being unlinked?');
    if (!reason || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/journal-document-links', {
        method: 'POST',
        body: JSON.stringify({
          action: 'unlink', journalEntryId, capturedDocumentId, reason: reason.trim(),
        }),
      });
      await assertOk(res, 'Could not unlink this document');
      await load();
      onChanged?.();
    } catch (err) {
      log.warn('LinkTaxInvoiceButton: unlink failed', { error: err }, 'LinkTaxInvoiceButton');
      setError(err instanceof ApiRequestError ? err.message : 'Could not unlink this document');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button" onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs text-teal-400 hover:text-teal-300"
      >
        <Link2 className="h-3.5 w-3.5" />
        Link tax invoice
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] p-3 space-y-2 text-xs">
      {error && <p className="text-red-400">{error}</p>}
      {links.map((l) => (
        <div key={l.id} className="flex items-center justify-between gap-2">
          <span className="text-[var(--ff-text-secondary)]">Linked document: {l.capturedDocumentId}</span>
          <button type="button" disabled={busy} onClick={() => void unlink(l.capturedDocumentId)}
            className="inline-flex items-center gap-1 text-red-400 hover:text-red-300 disabled:opacity-50">
            <Unlink className="h-3 w-3" /> Unlink
          </button>
        </div>
      ))}
      {links.length === 0 && (
        <>
          <select
            value={selectedId} onChange={(e) => setSelectedId(e.target.value)}
            className="w-full rounded border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-2 py-1"
          >
            <option value="">Select a captured document…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>{c.fileName}{c.documentType ? ` (${c.documentType})` : ''}</option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <button
              type="button" disabled={busy || !selectedId} onClick={() => void link()}
              className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />}
              Link
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-[var(--ff-text-secondary)]">
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
