import { useRef } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';
import type { CapturedDocument, ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

interface Props {
  isUploading: boolean;
  isDragging: boolean;
  onDraggingChange: (v: boolean) => void;
  onUploadComplete: (result: { document: CapturedDocument; extracted: ExtractedDocument }) => void;
  onUploadError: (msg: string) => void;
  onUploadStart: () => void;
  onRefreshList: () => void;
}

export function UploadZone({
  isUploading, isDragging, onDraggingChange,
  onUploadComplete, onUploadError, onUploadStart, onRefreshList,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(file: File) {
    const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif'];
    const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
    if (!allowedExts.includes(ext)) {
      notify.error('Supported formats: PDF, JPEG, PNG, WebP, TIFF');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      notify.error('File too large. Maximum size is 10MB.');
      return;
    }

    onUploadStart();
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiFetch('/api/accounting/document-capture', { method: 'POST', body: formData });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Upload failed');
      onUploadComplete(json.data);
      notify.success('Document uploaded and processed');
      onRefreshList();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      notify.error(msg);
      onUploadError(msg);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    onDraggingChange(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(e) => { e.preventDefault(); onDraggingChange(true); }}
      onDragLeave={(e) => { e.preventDefault(); onDraggingChange(false); }}
      className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer ${
        isDragging
          ? 'border-teal-500 bg-teal-500/5'
          : 'border-[var(--ff-border-light)] hover:border-teal-500/50 hover:bg-[var(--ff-bg-secondary)]'
      }`}
      onClick={() => fileInputRef.current?.click()}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf,image/jpeg,image/png,image/webp,image/tiff"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleUpload(file);
        }}
      />
      {isUploading ? (
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-10 w-10 text-teal-500 animate-spin" />
          <p className="text-sm text-[var(--ff-text-secondary)]">Processing document...</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <Upload className="h-10 w-10 text-[var(--ff-text-tertiary)]" />
          <div>
            <p className="text-sm font-medium text-[var(--ff-text-primary)]">
              Drop a document here or click to browse
            </p>
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
              Invoices, receipts, credit notes — PDF or image up to 10MB
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
