import { useState, useRef } from 'react';
import {
  FileText,
  Image as ImageIcon,
  File,
  Upload,
  Trash2,
  Download,
  Loader2,
  AlertCircle,
  X,
  Link2,
} from 'lucide-react';
import { useAccountingDocuments } from './useAccountingDocuments';
import {
  ACCOUNTING_DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPE_LABELS,
  type AccountingDocumentType,
  type AccountingEntityType,
  type ProcurementDocumentType,
} from '@/types/procurement/document.types';
import { formatDisplayDate } from '@/utils/dateFormat';

interface DocumentTypeOption {
  value: AccountingDocumentType;
  label: string;
}

interface AccountingDocumentPanelProps {
  entityType: AccountingEntityType;
  entityId: string;
  allowedTypes?: DocumentTypeOption[];
  readOnly?: boolean;
}

const DEFAULT_ALLOWED_TYPES: DocumentTypeOption[] = Object.entries(ACCOUNTING_DOCUMENT_TYPE_LABELS).map(
  ([value, label]) => ({ value: value as AccountingDocumentType, label })
);

function getFileIcon(mimeType?: string) {
  if (!mimeType) return File;
  if (mimeType === 'application/pdf') return FileText;
  if (mimeType.startsWith('image/')) return ImageIcon;
  return File;
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getTypeLabel(docType: string): string {
  return (ACCOUNTING_DOCUMENT_TYPE_LABELS as Record<string, string>)[docType]
    || (DOCUMENT_TYPE_LABELS as Record<string, string>)[docType]
    || docType;
}

const LINK_REASON_LABELS: Record<string, string> = {
  po_invoice_link: 'Linked from PO',
  grn_invoice_link: 'Linked from GRN',
  manual: 'Manually linked',
};

export function AccountingDocumentPanel({
  entityType,
  entityId,
  allowedTypes = DEFAULT_ALLOWED_TYPES,
  readOnly = false,
}: AccountingDocumentPanelProps) {
  const { documents, loading, error, uploadDocument, deleteDocument, uploading } =
    useAccountingDocuments(entityType, entityId);

  const [showUpload, setShowUpload] = useState(false);
  const [selectedType, setSelectedType] = useState<AccountingDocumentType>(
    allowedTypes[0]?.value || 'other'
  );
  const [notes, setNotes] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setSelectedFile(file);
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    try {
      await uploadDocument(selectedFile, selectedType, notes || undefined);
      setShowUpload(false);
      setSelectedFile(null);
      setNotes('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch {
      // Error handled by hook
    }
  };

  const handleDelete = async (docId: string, docName: string) => {
    if (!confirm(`Delete "${docName}"? This cannot be undone.`)) return;
    await deleteDocument(docId);
  };

  return (
    <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--ff-border-light)]">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-blue-400" />
          <h3 className="font-semibold text-[var(--ff-text-primary)]">
            Documents {documents.length > 0 && `(${documents.length})`}
          </h3>
        </div>
        {!readOnly && (
          <button
            onClick={() => setShowUpload(!showUpload)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Upload className="h-4 w-4" />
            Upload
          </button>
        )}
      </div>

      {/* Upload Form */}
      {showUpload && (
        <div className="px-5 py-4 border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">File</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx"
                onChange={handleFileSelect}
                className="block w-full text-sm text-[var(--ff-text-secondary)] file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:bg-blue-600 file:text-white hover:file:bg-blue-700 file:cursor-pointer"
              />
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
                PDF, JPEG, PNG, DOCX, XLSX — max 20MB
              </p>
            </div>

            <div>
              <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Document Type</label>
              <select
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value as AccountingDocumentType)}
                className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
              >
                {allowedTypes.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
                Notes <span className="text-[var(--ff-text-tertiary)]">(optional)</span>
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Scanned invoice from supplier"
                className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm placeholder:text-[var(--ff-text-tertiary)]"
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleUpload}
                disabled={!selectedFile || uploading}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploading ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Uploading...</>
                ) : (
                  <><Upload className="h-4 w-4" /> Upload Document</>
                )}
              </button>
              <button
                onClick={() => { setShowUpload(false); setSelectedFile(null); setNotes(''); }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
              >
                <X className="h-4 w-4" /> Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-5 py-3 bg-red-500/10 border-b border-red-500/30 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Document List */}
      <div className="divide-y divide-[var(--ff-border-light)]">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
          </div>
        ) : documents.length === 0 ? (
          <div className="text-center py-8">
            <FileText className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
            <p className="text-sm text-[var(--ff-text-secondary)]">No documents uploaded yet</p>
          </div>
        ) : (
          documents.map((doc) => {
            const Icon = getFileIcon(doc.mimeType);
            const typeLabel = getTypeLabel(doc.documentType);
            const isLinked = doc.source === 'linked';

            return (
              <div
                key={`${doc.id}-${doc.source}`}
                className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--ff-bg-hover)] transition-colors"
              >
                <div className={`p-2 rounded-lg shrink-0 ${isLinked ? 'bg-purple-500/10' : 'bg-blue-500/10'}`}>
                  <Icon className={`h-5 w-5 ${isLinked ? 'text-purple-400' : 'text-blue-400'}`} />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--ff-text-primary)] truncate">
                    {doc.documentName}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-[var(--ff-text-tertiary)]">
                    <span className="px-1.5 py-0.5 rounded bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]">
                      {typeLabel}
                    </span>
                    {isLinked && doc.linkReason && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">
                        <Link2 className="h-3 w-3" />
                        {LINK_REASON_LABELS[doc.linkReason] || doc.linkReason}
                      </span>
                    )}
                    {doc.fileSize && <span>{formatFileSize(doc.fileSize)}</span>}
                    <span>{formatDisplayDate(doc.uploadedAt)}</span>
                    {doc.uploadedByName && <span>by {doc.uploadedByName}</span>}
                  </div>
                  {doc.notes && (
                    <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5 truncate">{doc.notes}</p>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <a
                    href={doc.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1.5 hover:bg-[var(--ff-bg-tertiary)] rounded-lg transition-colors"
                    title="Download"
                  >
                    <Download className="h-4 w-4 text-[var(--ff-text-secondary)]" />
                  </a>
                  {!readOnly && !isLinked && (
                    <button
                      onClick={() => handleDelete(doc.id, doc.documentName)}
                      className="p-1.5 hover:bg-red-500/10 rounded-lg transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4 text-red-400" />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
