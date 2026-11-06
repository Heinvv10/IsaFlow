/**
 * One file in BankTxAttachmentsModal: icon, name and size, then View (only for a file the viewer can show, see
 * ./attachmentPreview), Download (only for a url ./attachmentPreview's canDownload allows) and Remove, except on a
 * captured document, whose link document capture owns.
 */

import { Eye, FileImage, FileText, Loader2, Paperclip, Trash2, Upload } from 'lucide-react';
import { formatDisplayDate } from '@/utils/dateFormat';
import { type Attachment, formatBytes, fileIcon } from './bankTxAttachmentHelpers';
import { canDownload, previewKind, safeDownloadName } from './attachmentPreview';

interface Props {
  att: Attachment;
  deleting: boolean;
  onView: () => void;
  onDelete: () => void;
}

const ICON_BTN = 'shrink-0 p-1.5 rounded text-[var(--ff-text-tertiary)] transition-colors';

export function BankTxAttachmentRow({ att, deleting, onView, onDelete }: Props) {
  const icon = fileIcon(att.file_name);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2.5">
      <div className="shrink-0 p-1.5 rounded bg-[var(--ff-bg-secondary)]">
        {icon === 'image' ? (
          <FileImage className="h-4 w-4 text-blue-400" aria-hidden="true" />
        ) : icon === 'pdf' ? (
          <FileText className="h-4 w-4 text-orange-400" aria-hidden="true" />
        ) : (
          <Paperclip className="h-4 w-4 text-[var(--ff-text-tertiary)]" aria-hidden="true" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-[var(--ff-text-primary)] truncate">{att.file_name}</p>
        <p className="text-xs text-[var(--ff-text-tertiary)]">
          {att.source === 'captured' ? 'Captured document · ' : ''}
          {formatBytes(att.file_size)}{att.file_size ? ' · ' : ''}{formatDisplayDate(att.created_at)}
        </p>
      </div>

      {previewKind(att.file_url, att.content_type) !== 'none' && (
        <button type="button" onClick={onView} title="View" aria-label={`View ${att.file_name}`}
          className={`${ICON_BTN} hover:bg-blue-500/10 hover:text-blue-400`}>
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}

      {/* Download link — only rendered when the URL is a safe scheme */}
      {canDownload(att.file_url) ? (
        <a href={att.file_url} download={safeDownloadName(att.file_url, att.file_name, att.content_type)} target="_blank" rel="noopener noreferrer"
          className={`${ICON_BTN} hover:bg-blue-500/10 hover:text-blue-400`}
          title="Download" aria-label={`Download ${att.file_name}`} onClick={e => e.stopPropagation()}>
          <Upload className="h-3.5 w-3.5 rotate-180" />
        </a>
      ) : (
        <span className="shrink-0 p-1.5 text-[var(--ff-text-tertiary)]" title={att.file_name}>
          <Upload className="h-3.5 w-3.5 rotate-180 opacity-30" />
        </span>
      )}

      {/* A captured document's link belongs to document capture, which owns its status: it is unlinked there, not here. */}
      {att.source !== 'captured' && (
        <button type="button" disabled={deleting} onClick={onDelete} title="Remove" aria-label={`Remove ${att.file_name}`}
          className={`${ICON_BTN} hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40`}>
          {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
}
