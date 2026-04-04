/**
 * Document Capture Hub — thin shell
 * Upload PDFs, extract invoice/receipt data via OCR, review and act on results.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ScanLine, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { CapturedDocument, ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { UploadZone } from '@/components/accounting/document-capture/UploadZone';
import { ExtractionReview } from '@/components/accounting/document-capture/ExtractionReview';
import { DocumentList } from '@/components/accounting/document-capture/DocumentList';

interface ReviewForm {
  vendor: string;
  date: string;
  ref: string;
  total: string;
  vat: string;
  docType: string;
  notes: string;
}

const BLANK_REVIEW: ReviewForm = { vendor: '', date: '', ref: '', total: '', vat: '', docType: '', notes: '' };

export default function DocumentCapturePage() {
  const [documents, setDocuments] = useState<CapturedDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ document: CapturedDocument; extracted: ExtractedDocument } | null>(null);
  const [reviewForm, setReviewForm] = useState<ReviewForm>({ ...BLANK_REVIEW });

  const loadDocuments = useCallback(async () => {
    setIsLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const res = await apiFetch(`/api/accounting/document-capture?${params}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Failed to load');
      setDocuments(json.data || []);
      setTotal(json.pagination?.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally { setIsLoading(false); }
  }, [statusFilter]);

  useEffect(() => { loadDocuments(); }, [loadDocuments]);

  // Populate review form when upload completes
  useEffect(() => {
    if (uploadResult) {
      const ex = uploadResult.extracted;
      setReviewForm({
        vendor: ex.vendorName || '',
        date: ex.date || '',
        ref: ex.referenceNumber || '',
        total: ex.totalAmount !== null ? String(ex.totalAmount) : '',
        vat: ex.vatAmount !== null ? String(ex.vatAmount) : '',
        docType: ex.documentType || 'unknown',
        notes: '',
      });
    }
  }, [uploadResult]);

  const handleFormChange = (field: keyof ReviewForm, value: string) =>
    setReviewForm(prev => ({ ...prev, [field]: value }));

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <ScanLine className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Document Capture</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Upload invoices and receipts for automated data extraction</p>
              </div>
            </div>
            <button onClick={() => loadDocuments()}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] border border-[var(--ff-border-light)] rounded-lg hover:bg-[var(--ff-bg-tertiary)] transition-colors">
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
          </div>
        </div>

        <div className="p-6 space-y-6">
          <UploadZone
            isUploading={isUploading}
            isDragging={isDragging}
            onDraggingChange={setIsDragging}
            onUploadStart={() => { setIsUploading(true); setUploadResult(null); setError(''); }}
            onUploadComplete={(result) => { setUploadResult(result); setIsUploading(false); }}
            onUploadError={(msg) => { setError(msg); setIsUploading(false); }}
            onRefreshList={loadDocuments}
          />

          {uploadResult && (
            <ExtractionReview
              uploadResult={uploadResult}
              form={reviewForm}
              onChange={handleFormChange}
              onDismiss={() => setUploadResult(null)}
              onRefreshList={loadDocuments}
            />
          )}

          <DocumentList
            documents={documents}
            total={total}
            isLoading={isLoading}
            error={error}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
          />
        </div>
      </div>
    </AppLayout>
  );
}
