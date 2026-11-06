/**
 * AttachmentViewer — shows an attachment in place (image or PDF) instead of downloading it, with Previous / Next
 * across the list, a Download of the shown file, and Escape / arrow keys. Each file is shown from a blob: URL made
 * from its data URL and freed when the viewer moves on or closes (see ./attachmentPreview for what is previewable).
 *
 * Focus is trapped in the viewer and put back on close (useFocusTrap, which also owns Escape and stops it there, so it
 * closes only the viewer). The arrow keys are handled on the dialog and stopped there too. When a step disables the
 * button that had focus (Next on the last file), focus moves to the dialog itself, so the keys keep arriving.
 *
 * Rendered into document.body: AppLayout's main column is `relative z-0`, a stacking context no z-index inside it can
 * leave, so rendered in place the top nav (z-40) drew over the viewer. React events still bubble to the opener's tree.
 *
 * Known limit: once a click lands inside a PDF, keys go to the browser's PDF viewer and this page cannot see them.
 * Close and the backdrop still work.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, FileX, X } from 'lucide-react';
import { useFocusTrap } from '@/components/ui/useFocusTrap';
import { isCapturedFile, safeDownloadName } from './attachmentPreview';
import { useAttachmentBlob } from './useAttachmentBlob';

export interface ViewableAttachment {
  id: string;
  file_name: string;
  file_url: string;
  /** A captured document's claimed type (see ./useAttachmentBlob). */
  content_type?: string | null;
}

interface Props {
  attachments: ViewableAttachment[];
  startIndex: number;
  onClose: () => void;
}

// Larger targets at phone width.
const NAV = 'p-2.5 sm:p-1.5 rounded text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-primary)] hover:text-[var(--ff-text-primary)] disabled:opacity-30 disabled:pointer-events-none';

export function AttachmentViewer({ attachments, startIndex, onClose }: Props) {
  const [index, setIndex] = useState(startIndex);
  const dialogRef = useRef<HTMLDivElement>(null);
  const file = attachments[index];
  const { blob, loading, missing } = useAttachmentBlob(file);
  // What is shown follows the blob's own type, which for a captured document comes from its bytes.
  const kind = !blob ? 'none' : blob.type === 'application/pdf' ? 'pdf' : 'image';
  // Made and freed in one effect, not a memo: StrictMode runs effects twice, and a memoised URL would be revoked
  // by the first cleanup and then shown dead.
  // Keyed by its blob, so the render after a step never shows the previous file's (already freed) URL.
  const [shown, setShown] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) return undefined;
    const url = URL.createObjectURL(blob);
    setShown({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  const blobUrl = shown && shown.blob === blob ? shown.url : null;
  useFocusTrap(dialogRef, true, onClose);
  useEffect(() => {
    const dialog = dialogRef.current;
    const focused = document.activeElement;
    if (dialog && (!dialog.contains(focused) || (focused instanceof HTMLButtonElement && focused.disabled))) dialog.focus();
  }, [index]);

  if (!file) return null;
  const hasPrev = index > 0;
  const hasNext = index < attachments.length - 1;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' && hasPrev) setIndex(index - 1);
    else if (e.key === 'ArrowRight' && hasNext) setIndex(index + 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={dialogRef} tabIndex={-1} className="fixed inset-0 z-[60] flex flex-col bg-black/80 outline-none" role="dialog"
      aria-modal="true" aria-label="Attachment preview" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 px-4 py-2 bg-[var(--ff-bg-secondary)] border-b border-[var(--ff-border-light)]">
        <p className="flex-1 min-w-0 truncate text-sm font-medium text-[var(--ff-text-primary)]">{file.file_name}</p>
        <span className="text-xs text-[var(--ff-text-tertiary)]">{index + 1} of {attachments.length}</span>
        <button type="button" className={NAV} disabled={!hasPrev} onClick={() => setIndex(index - 1)}
          aria-label="Previous attachment" title="Previous attachment">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" className={NAV} disabled={!hasNext} onClick={() => setIndex(index + 1)}
          aria-label="Next attachment" title="Next attachment">
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
        {/* A captured document it cannot show still downloads from its route, as octet-stream. */}
        {(blobUrl || (!loading && !blob && !missing && isCapturedFile(file.file_url))) && (
          // Named for the type the bytes proved when they were shown, else the type claimed.
          <a href={blobUrl ?? file.file_url} download={safeDownloadName(file.file_url, file.file_name, blob?.type ?? file.content_type)} className={NAV}
            aria-label={`Download ${file.file_name}`} title="Download">
            <Download className="h-4 w-4" aria-hidden="true" />
          </a>
        )}
        <button type="button" className={NAV} onClick={onClose} aria-label="Close preview" title="Close preview">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center p-4" onClick={onClose}>
        {blobUrl && kind === 'image' ? (
          <img src={blobUrl} alt={file.file_name} onClick={e => e.stopPropagation()}
            className="max-h-full max-w-full object-contain rounded shadow-2xl bg-white" />
        ) : blobUrl && kind === 'pdf' ? (
          // A new frame per file (key): changing src on one frame adds a history entry per file.
          <iframe key={blobUrl} src={blobUrl} title={file.file_name}
            className="h-full w-full max-w-5xl rounded bg-white" />
        ) : blob ? null : loading ? (
          <p className="text-sm text-[var(--ff-text-secondary)]" onClick={e => e.stopPropagation()}>Loading…</p>
        ) : (
          <div className="flex flex-col items-center gap-2 text-sm text-[var(--ff-text-secondary)]" onClick={e => e.stopPropagation()}>
            <FileX className="h-8 w-8" aria-hidden="true" />
            <p>{missing ? 'This file is missing from storage' : 'Preview not available for this file'}</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
