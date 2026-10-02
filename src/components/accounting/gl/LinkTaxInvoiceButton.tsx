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
import { Link2, Unlink } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { InlineReasonForm } from '@/components/shared/InlineReasonForm';

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
  const [confirmingLink, setConfirmingLink] = useState(false);
  const [confirmingUnlinkId, setConfirmingUnlinkId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/accounting/journal-document-links?journal_entry_id=${journalEntryId}`);
      await assertOk(res, 'Could not load the linked documents - try again');
      const body = await res.json();
      const data = body.data ?? body;
      setLinks(data.links ?? []);
      setCandidates(data.candidates ?? []);
      setSelectedId((data.candidates ?? [])[0]?.id ?? '');
    } catch (err) {
      setLinks([]); setCandidates([]); setSelectedId('');
      setError(apiErrorMessage(err, 'Could not load the linked documents - try again'));
    }
  }, [journalEntryId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const link = async (reason: string) => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/journal-document-links', {
        method: 'POST',
        body: JSON.stringify({
          action: 'link', journalEntryId, capturedDocumentId: selectedId, reason,
        }),
      });
      await assertOk(res, 'Could not link this document');
      setOpen(false);
      setConfirmingLink(false);
      onChanged?.();
    } catch (err) {
      log.warn('LinkTaxInvoiceButton: link failed', { error: err }, 'LinkTaxInvoiceButton');
      setError(apiErrorMessage(err, 'Could not link this document'));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (capturedDocumentId: string, reason: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/journal-document-links', {
        method: 'POST',
        body: JSON.stringify({
          action: 'unlink', journalEntryId, capturedDocumentId, reason,
        }),
      });
      await assertOk(res, 'Could not unlink this document');
      await load();
      setConfirmingUnlinkId(null);
      onChanged?.();
    } catch (err) {
      log.warn('LinkTaxInvoiceButton: unlink failed', { error: err }, 'LinkTaxInvoiceButton');
      setError(apiErrorMessage(err, 'Could not unlink this document'));
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
        <div key={l.id} className="space-y-2">
          {confirmingUnlinkId === l.id ? (
            <InlineReasonForm
              label="Why is this document being unlinked?"
              confirmLabel="Unlink"
              busy={busy}
              onConfirm={(reason) => void unlink(l.capturedDocumentId, reason)}
              onCancel={() => setConfirmingUnlinkId(null)}
            />
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[var(--ff-text-secondary)]">Linked document: {l.capturedDocumentId}</span>
              <button type="button" onClick={() => setConfirmingUnlinkId(l.id)}
                className="inline-flex items-center gap-1 text-red-400 hover:text-red-300 disabled:opacity-50">
                <Unlink className="h-3 w-3" /> Unlink
              </button>
            </div>
          )}
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
          {confirmingLink ? (
            <InlineReasonForm
              label="Why does this document back this journal's VAT claim?"
              confirmLabel="Link"
              busy={busy}
              onConfirm={(reason) => void link(reason)}
              onCancel={() => setConfirmingLink(false)}
            />
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button" disabled={!selectedId} onClick={() => setConfirmingLink(true)}
                className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300 disabled:opacity-50"
              >
                <Link2 className="h-3 w-3" />
                Link
              </button>
              <button type="button" onClick={() => setOpen(false)} className="text-[var(--ff-text-secondary)]">
                Cancel
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
