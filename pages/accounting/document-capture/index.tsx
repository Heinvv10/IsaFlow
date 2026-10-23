/**
 * Document Capture Hub — thin shell
 * Upload PDFs, extract invoice/receipt data via OCR, review and act on results.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ScanLine, RefreshCw } from 'lucide-react';
import { ApiEnvelopeError, ApiRequestError, apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { usePollWhileReading, type PollOutcome } from '@/hooks/usePollWhileReading';
import { useRetryCaptureRead } from '@/hooks/useRetryCaptureRead';
import type { CapturedDocument } from '@/modules/accounting/types/documentCapture.types';
import { UploadZone } from '@/components/accounting/document-capture/UploadZone';
import { ExtractionReview } from '@/components/accounting/document-capture/ExtractionReview';
import { DocumentList } from '@/components/accounting/document-capture/DocumentList';
import { CaptureReadStatus } from '@/components/accounting/document-capture/CaptureReadStatus';

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
  const [uploaded, setUploaded] = useState<CapturedDocument | null>(null);
  const [reviewForm, setReviewForm] = useState<ReviewForm>({ ...BLANK_REVIEW });

  // Every list request takes a ticket; `loadSeq` counts only the loads (spinner), `listSeq` loads and polls.
  // An answer whose ticket is no longer the latest (the filter changed, a newer request went out) is dropped.
  const loadSeq = useRef(0);
  const listSeq = useRef(0);

  const loadDocuments = useCallback(async () => {
    const mine = ++loadSeq.current;
    listSeq.current += 1;
    setIsLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const res = await apiFetch(`/api/accounting/document-capture?${params}`);
      await assertOk(res, 'Could not load documents - try again');
      const json = await res.json();
      if (!json.success) throw new ApiEnvelopeError(json.error?.message || 'Could not load documents - try again');
      if (mine !== loadSeq.current) return;
      setDocuments(json.data || []);
      setTotal(json.pagination?.total || 0);
    } catch (err) {
      if (mine !== loadSeq.current) return;
      setDocuments([]);
      setTotal(0);
      setError(apiErrorMessage(err, 'Could not load documents - try again'));
    } finally { if (mine === loadSeq.current) setIsLoading(false); }
  }, [statusFilter]);

  useEffect(() => { void loadDocuments(); }, [loadDocuments]);

  // The upload answers at once; the read runs in the background. Poll the document until it is done or failed.
  // 'stop' when it is gone or not ours (404/403), 'bad' for any other error (the hook backs off).
  const uploadedId = uploaded?.id;
  const currentUploadedId = useRef(uploadedId); // an answer about any other document is dropped
  currentUploadedId.current = uploadedId;
  const pollUploaded = useCallback(async (): Promise<PollOutcome> => {
    if (!uploadedId) return 'ok';
    try {
      const res = await apiFetch(`/api/accounting/document-capture?id=${encodeURIComponent(uploadedId)}`);
      await assertOk(res, 'Could not check the document - try again');
      const json = await res.json() as { data?: CapturedDocument };
      if (json.data && currentUploadedId.current === uploadedId) setUploaded(json.data);
      return 'ok';
    } catch (err) {
      return err instanceof ApiRequestError && (err.status === 404 || err.status === 403) ? 'stop' : 'bad';
    }
  }, [uploadedId]);
  usePollWhileReading(uploaded?.readState === 'reading' ? 'extracting' : undefined, pollUploaded);

  // Retry a failed read: the server re-arms the row, and the polling above picks it up as after an upload.
  const { retry, isRetrying } = useRetryCaptureRead(setUploaded);

  // Fill the review form once the read is done (not on every poll while it is still reading).
  const doneDoc = uploaded?.readState === 'done' ? uploaded : null;
  useEffect(() => {
    const ex = doneDoc?.extractedData;
    if (!ex) return;
    setReviewForm({
      vendor: ex.vendorName || '',
      date: ex.date || '',
      ref: ex.referenceNumber || '',
      total: ex.totalAmount !== null ? String(ex.totalAmount) : '',
      vat: ex.vatAmount !== null ? String(ex.vatAmount) : '',
      docType: ex.documentType || 'unknown',
      notes: '',
    });
  }, [doneDoc]);

  // Documents read in the background stay in the list: refresh it quietly while any is still being read.
  const pollList = useCallback(async (): Promise<PollOutcome> => {
    const mine = ++listSeq.current;
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const res = await apiFetch(`/api/accounting/document-capture?${params}`);
      await assertOk(res, 'Could not load documents - try again');
      const json = await res.json() as { data?: CapturedDocument[]; pagination?: { total?: number } };
      if (json.data && mine === listSeq.current) { setDocuments(json.data); setTotal(json.pagination?.total || 0); }
      return 'ok';
    } catch (err) {
      return err instanceof ApiRequestError && (err.status === 403) ? 'stop' : 'bad';
    }
  }, [statusFilter]);
  usePollWhileReading(documents.some(d => d.readState === 'reading') ? 'extracting' : undefined, pollList);

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
            onUploadStart={() => { setIsUploading(true); setUploaded(null); setError(''); }}
            onUploadComplete={(result) => { setUploaded(result.document); setIsUploading(false); }}
            onUploadError={(msg) => { setError(msg); setIsUploading(false); }}
            onRefreshList={loadDocuments}
          />

          {uploaded && uploaded.readState !== 'done' && (
            <CaptureReadStatus
              readState={uploaded.readState}
              readError={uploaded.readError}
              retryable={uploaded.retryable}
              isRetrying={isRetrying}
              onRetry={() => { void retry(uploaded.id); }}
            />
          )}

          {doneDoc?.extractedData && (
            <ExtractionReview
              uploadResult={{ document: doneDoc, extracted: doneDoc.extractedData }}
              form={reviewForm}
              onChange={handleFormChange}
              onDismiss={() => setUploaded(null)}
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
