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
 *   onClose               — Dismiss callback
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Paperclip, Trash2, Upload, FileImage, FileText, AlertCircle, Loader2 } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Attachment {
  id: string;
  bank_transaction_id: string;
  file_url: string;
  file_name: string;
  file_size: number | null;
  uploaded_by: string | null;
  created_at: string;
}

interface Props {
  bankTransactionId: string;
  transactionDescription?: string;
  onClose: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ACCEPT = '.jpg,.jpeg,.png,.pdf';
const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'application/pdf'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function fileIcon(name: string): 'image' | 'pdf' | 'generic' {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return 'generic';
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

// 🟢 WORKING: Attachment list + upload modal for bank transactions
export function BankTxAttachmentsModal({ bankTransactionId, transactionDescription, onClose }: Props) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Fetch attachment list ──────────────────────────────────────────────────
  const fetchAttachments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(
        `/api/accounting/bank-tx-attachments?bankTransactionId=${encodeURIComponent(bankTransactionId)}`,
      );
      const json = await res.json() as { success: boolean; data: Attachment[] };
      if (!res.ok || !json.success) throw new Error('Failed to load attachments');
      setAttachments(json.data);
    } catch {
      notify.error('Could not load attachments');
    } finally {
      setLoading(false);
    }
  }, [bankTransactionId]);

  useEffect(() => { void fetchAttachments(); }, [fetchAttachments]);

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
      const json = await res.json() as { success: boolean; message?: string };
      if (!res.ok || !json.success) throw new Error(json.message ?? 'Upload failed');
      notify.success(`${file.name} uploaded`);
      await fetchAttachments();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Upload failed');
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
      const json = await res.json() as { success: boolean; message?: string };
      if (!res.ok || !json.success) throw new Error(json.message ?? 'Delete failed');
      notify.success(`${name} removed`);
      setAttachments(prev => prev.filter(a => a.id !== id));
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
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
                <p className="text-[10px] text-[var(--ff-text-tertiary)]">
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
            attachments.map(att => {
              const icon = fileIcon(att.file_name);
              const isDeleting = deletingId === att.id;
              return (
                <div
                  key={att.id}
                  className="flex items-center gap-3 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2.5"
                >
                  {/* File type icon */}
                  <div className="shrink-0 p-1.5 rounded bg-[var(--ff-bg-secondary)]">
                    {icon === 'image' ? (
                      <FileImage className="h-4 w-4 text-blue-400" />
                    ) : icon === 'pdf' ? (
                      <FileText className="h-4 w-4 text-orange-400" />
                    ) : (
                      <Paperclip className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                    )}
                  </div>

                  {/* Name + meta */}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-[var(--ff-text-primary)] truncate">
                      {att.file_name}
                    </p>
                    <p className="text-[10px] text-[var(--ff-text-tertiary)]">
                      {formatBytes(att.file_size)}{att.file_size ? ' · ' : ''}{formatDate(att.created_at)}
                    </p>
                  </div>

                  {/* Download link */}
                  <a
                    href={att.file_url}
                    download={att.file_name}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 p-1.5 rounded hover:bg-blue-500/10 text-[var(--ff-text-tertiary)] hover:text-blue-400 transition-colors"
                    title="Download"
                    onClick={e => e.stopPropagation()}
                  >
                    <Upload className="h-3.5 w-3.5 rotate-180" />
                  </a>

                  {/* Delete */}
                  <button
                    disabled={isDeleting}
                    onClick={() => void handleDelete(att.id, att.file_name)}
                    className="shrink-0 p-1.5 rounded hover:bg-red-500/10 text-[var(--ff-text-tertiary)] hover:text-red-400 disabled:opacity-40 transition-colors"
                    title="Remove"
                  >
                    {isDeleting
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Trash2 className="h-3.5 w-3.5" />
                    }
                  </button>
                </div>
              );
            })
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
    </div>
  );
}
