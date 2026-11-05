/**
 * BankTxAttachmentsModal
 *
 * View, upload, and delete file attachments (receipts, invoices, PDFs) for a
 * single bank transaction. Files are stored as base64 data URLs in the
 * bank_transaction_attachments table (suitable for small receipts ≤ 2 MB).
 *
 * Props:
 *   bankTransactionId     — UUID of the target bank transaction
 *   transactionDescription — Optional label shown in the modal header
 *   openFirst             — Open the first viewable file once the list has loaded
 *   onCountChange         — Told the file count after every successful load and remove
 *   onClose               — Dismiss callback
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Paperclip, Upload, AlertCircle, Loader2 } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch, assertOk, apiErrorMessage, ApiEnvelopeError } from '@/lib/apiFetch';
import { type Attachment, MAX_BYTES, ACCEPT, ACCEPTED_MIME, readFileAsDataUrl } from './bankTxAttachmentHelpers';
import { BankTxAttachmentRow } from './BankTxAttachmentRow';
import { AttachmentViewer } from './AttachmentViewer';
import { previewKind } from './attachmentPreview';
import { useFocusTrap } from '@/components/ui/useFocusTrap';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  bankTransactionId: string;
  transactionDescription?: string;
  /** Open the first viewable file as soon as the list loads (the row's paperclip was highlighted). */
  openFirst?: boolean;
  /** Called with the file count after every load and remove, so the row's paperclip can follow. */
  onCountChange?: (count: number) => void;
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

// 🟢 WORKING: Attachment list + upload modal for bank transactions
export function BankTxAttachmentsModal({ bankTransactionId, transactionDescription, openFirst, onCountChange, onClose }: Props) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  // Tab stays in, Escape closes, focus returns to the opener. Off while the viewer replaces the list (the viewer has
  // its own); back on when it closes, which also takes focus back into the list: the View button that opened the
  // viewer unmounted with the list, so the viewer cannot return focus to it.
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, viewIndex === null, onClose);
  // Refs, so a parent's inline callback does not re-create fetchAttachments (and re-fetch) on every render.
  const countRef = useRef(onCountChange);
  useEffect(() => { countRef.current = onCountChange; });
  const openFirstRef = useRef(openFirst);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Fetch attachment list ──────────────────────────────────────────────────
  // keepList: a refresh after an upload leaves the list on screen instead of blanking it to "Loading…".
  const fetchAttachments = useCallback(async (keepList = false) => {
    if (!keepList) setLoading(true);
    try {
      const res = await apiFetch(
        `/api/accounting/bank-tx-attachments?bankTransactionId=${encodeURIComponent(bankTransactionId)}`,
      );
      await assertOk(res, 'Could not load attachments');
      const json = await res.json() as { success: boolean; data: Attachment[] };
      if (!json.success) throw new ApiEnvelopeError('Could not load attachments');
      setAttachments(json.data);
      // Only a successful read reports a count: a failed one must not clear the row's highlight.
      countRef.current?.(json.data.length);
      if (openFirstRef.current && json.data.some(a => previewKind(a.file_url) !== 'none')) setViewIndex(0);
    } catch {
      setAttachments([]); notify.error('Could not load attachments');
    } finally {
      openFirstRef.current = false;
      setLoading(false);
    }
  }, [bankTransactionId]);

  useEffect(() => { void fetchAttachments(); }, [fetchAttachments]);

  // The viewer steps through the files it can show; the list keeps every file.
  const viewable = attachments.filter(a => previewKind(a.file_url) !== 'none');

  // ── Upload ─────────────────────────────────────────────────────────────────
  const handleUpload = useCallback(async (file: File) => {
    if (!ACCEPTED_MIME.includes(file.type)) {
      notify.error('Only JPG, PNG and PDF files are accepted');
      return;
    }
    if (file.size > MAX_BYTES) {
      notify.error('File exceeds the 2 MB limit');
      return;
    }

    setUploading(true);
    try {
      const fileData = await readFileAsDataUrl(file);
      const res = await apiFetch('/api/accounting/bank-tx-attachments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bankTransactionId,
          fileName: file.name,
          fileData,
          fileSize: file.size,
        }),
      });
      await assertOk(res, 'Could not upload the file - try again');
      const json = await res.json() as { success: boolean; error?: { message?: string } };
      if (!json.success) throw new ApiEnvelopeError(json.error?.message ?? 'Could not upload the file - try again');
      notify.success(`${file.name} uploaded`);
      await fetchAttachments(true);
      setViewIndex(null); // The list changed behind any open viewer, so its index no longer names the same file.
    } catch (err) {
      notify.error(apiErrorMessage(err, 'Could not upload the file - try again'));
    } finally {
      setUploading(false);
    }
  }, [bankTransactionId, fetchAttachments]);

  // ── File input change ──────────────────────────────────────────────────────
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleUpload(file);
    e.target.value = '';
  };

  // ── Drag-and-drop ──────────────────────────────────────────────────────────
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleUpload(file);
  };

  // ── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = async (id: string, name: string) => {
    setDeletingId(id);
    try {
      const res = await apiFetch(
        `/api/accounting/bank-tx-attachments?id=${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      await assertOk(res, 'Could not remove the attachment - try again');
      const json = await res.json() as { success: boolean; error?: { message?: string } };
      if (!json.success) throw new ApiEnvelopeError(json.error?.message ?? 'Could not remove the attachment - try again');
      notify.success(`${name} removed`);
      const next = attachments.filter(a => a.id !== id);
      setAttachments(next);
      setViewIndex(null);
      countRef.current?.(next.length);
    } catch (err) {
      notify.error(apiErrorMessage(err, 'Could not remove the attachment - try again'));
    } finally {
      setDeletingId(null);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  if (viewIndex !== null && viewable[viewIndex]) {
    return <AttachmentViewer attachments={viewable} startIndex={viewIndex} onClose={() => setViewIndex(null)} />;
  }
  // Into document.body: AppLayout's main column is `relative z-0`, so in place the top nav drew over the backdrop.
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={dialogRef} tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 outline-none" role="dialog" aria-modal="true" aria-label="Attachments">
      <div
        className="w-full max-w-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl flex flex-col max-h-[85vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--ff-border-light)] shrink-0">
          <div className="p-2 rounded-lg bg-blue-500/10">
            <Paperclip className="h-4 w-4 text-blue-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Attachments</h2>
            {transactionDescription && (
              <p className="text-xs text-[var(--ff-text-tertiary)] truncate">{transactionDescription}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close attachments"
            className="p-1.5 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Upload zone ────────────────────────────────────────────────── */}
        <div className="px-5 pt-4 shrink-0">
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => !uploading && fileInputRef.current?.click()}
            className={`relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed py-5 cursor-pointer transition-colors ${
              dragOver
                ? 'border-blue-400 bg-blue-500/10'
                : 'border-[var(--ff-border-light)] hover:border-[var(--ff-text-tertiary)] bg-[var(--ff-bg-primary)]'
            }`}
          >
            {uploading ? (
              <>
                <Loader2 className="h-5 w-5 text-blue-400 animate-spin" />
                <span className="text-xs text-[var(--ff-text-secondary)]">Uploading…</span>
              </>
            ) : (
              <>
                <Upload className="h-5 w-5 text-[var(--ff-text-tertiary)]" />
                <p className="text-xs text-[var(--ff-text-secondary)] text-center">
                  Drag &amp; drop or{' '}
                  <span className="text-blue-400 font-medium">click to browse</span>
                </p>
                <p className="text-xs text-[var(--ff-text-tertiary)]">
                  JPG, PNG, PDF — max 2 MB
                </p>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={handleFileChange}
              disabled={uploading}
            />
          </div>
        </div>

        {/* ── Attachment list ─────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-8 gap-2 text-[var(--ff-text-tertiary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs">Loading…</span>
            </div>
          ) : attachments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 gap-2 text-[var(--ff-text-tertiary)]">
              <AlertCircle className="h-5 w-5" />
              <span className="text-xs">No attachments yet</span>
            </div>
          ) : (
            attachments.map(att => (
              <BankTxAttachmentRow key={att.id} att={att} deleting={deletingId === att.id}
                onView={() => setViewIndex(viewable.indexOf(att))} onDelete={() => void handleDelete(att.id, att.file_name)} />
            ))
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div className="border-t border-[var(--ff-border-light)] px-5 py-3 flex items-center justify-between shrink-0">
          <span className="text-xs text-[var(--ff-text-tertiary)]">
            {attachments.length} attachment{attachments.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded text-xs border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
