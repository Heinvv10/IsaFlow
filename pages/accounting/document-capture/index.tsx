/**
 * Document Capture Hub
 * Upload PDFs, extract invoice/receipt data via OCR, review and act on results.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ScanLine, Upload, Loader2, AlertCircle, FileText, CheckCircle2,
  XCircle, Eye, RefreshCw, ChevronRight,
} from 'lucide-react';
import { notify } from '@/utils/toast';
import type { CapturedDocument, ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-amber-500/20 text-amber-400',
    reviewed: 'bg-blue-500/20 text-blue-400',
    matched: 'bg-teal-500/20 text-teal-400',
    rejected: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  let color = 'text-red-400';
  let label = 'Low';
  if (confidence >= 0.7) { color = 'text-teal-400'; label = 'High'; }
  else if (confidence >= 0.4) { color = 'text-amber-400'; label = 'Medium'; }
  return (
    <span className={`text-xs font-medium ${color}`}>
      {label} ({Math.round(confidence * 100)}%)
    </span>
  );
}

export default function DocumentCapturePage() {
  const [documents, setDocuments] = useState<CapturedDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // Upload state
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ document: CapturedDocument; extracted: ExtractedDocument } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Review form state (after upload)
  const [reviewVendor, setReviewVendor] = useState('');
  const [reviewDate, setReviewDate] = useState('');
  const [reviewRef, setReviewRef] = useState('');
  const [reviewTotal, setReviewTotal] = useState('');
  const [reviewVat, setReviewVat] = useState('');
  const [reviewDocType, setReviewDocType] = useState('');
  const [reviewNotes, setReviewNotes] = useState('');

  const loadDocuments = useCallback(async () => {
    setIsLoading(true);
    setError('');
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
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { loadDocuments(); }, [loadDocuments]);

  // Populate review form when upload completes
  useEffect(() => {
    if (uploadResult) {
      const ex = uploadResult.extracted;
      setReviewVendor(ex.vendorName || '');
      setReviewDate(ex.date || '');
      setReviewRef(ex.referenceNumber || '');
      setReviewTotal(ex.totalAmount !== null ? String(ex.totalAmount) : '');
      setReviewVat(ex.vatAmount !== null ? String(ex.vatAmount) : '');
      setReviewDocType(ex.documentType || 'unknown');
      setReviewNotes('');
    }
  }, [uploadResult]);

  async function handleUpload(file: File) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      notify.error('Only PDF files are supported');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      notify.error('File too large. Maximum size is 10MB.');
      return;
    }

    setIsUploading(true);
    setUploadResult(null);
    setError('');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await apiFetch('/api/accounting/document-capture', {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Upload failed');

      setUploadResult(json.data);
      notify.success('Document uploaded and processed');
      loadDocuments();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      notify.error(msg);
      setError(msg);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }

  async function handleConfirm() {
    if (!uploadResult) return;
    try {
      const res = await apiFetch('/api/accounting/document-capture-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: uploadResult.document.id,
          action: 'confirm',
          data: {
            vendorName: reviewVendor || null,
            documentDate: reviewDate || null,
            referenceNumber: reviewRef || null,
            totalAmount: reviewTotal ? parseFloat(reviewTotal) : null,
            vatAmount: reviewVat ? parseFloat(reviewVat) : null,
            documentType: reviewDocType || null,
            notes: reviewNotes || null,
          },
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Confirm failed');
      notify.success('Document confirmed');
      setUploadResult(null);
      loadDocuments();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Confirm failed');
    }
  }

  async function handleReject() {
    if (!uploadResult) return;
    try {
      const res = await apiFetch('/api/accounting/document-capture-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: uploadResult.document.id,
          action: 'reject',
          data: { notes: reviewNotes || 'Rejected during review' },
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Reject failed');
      notify.success('Document rejected');
      setUploadResult(null);
      loadDocuments();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Reject failed');
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <ScanLine className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Document Capture</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Upload invoices and receipts for automated data extraction
                </p>
              </div>
            </div>
            <button
              onClick={() => loadDocuments()}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] border border-[var(--ff-border-light)] rounded-lg hover:bg-[var(--ff-bg-tertiary)] transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {/* Upload Zone */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
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
              accept=".pdf,application/pdf"
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
                    Drop a PDF here or click to browse
                  </p>
                  <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
                    Invoices, receipts, credit notes — PDF up to 10MB
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Extraction Review Panel */}
          {uploadResult && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] overflow-hidden">
              <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <FileText className="h-5 w-5 text-teal-500" />
                  <div>
                    <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                      Extraction Results
                    </h2>
                    <p className="text-xs text-[var(--ff-text-secondary)]">
                      {uploadResult.document.fileName}
                    </p>
                  </div>
                </div>
                <ConfidenceBadge confidence={uploadResult.extracted.confidence} />
              </div>

              {/* Warnings */}
              {uploadResult.extracted.warnings.length > 0 && (
                <div className="px-6 py-3 bg-amber-500/5 border-b border-[var(--ff-border-light)]">
                  {uploadResult.extracted.warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-amber-400">
                      <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Document Type</label>
                  <select
                    value={reviewDocType}
                    onChange={(e) => setReviewDocType(e.target.value)}
                    className="ff-select w-full text-sm"
                  >
                    <option value="invoice">Invoice</option>
                    <option value="credit_note">Credit Note</option>
                    <option value="receipt">Receipt</option>
                    <option value="statement">Statement</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Vendor Name</label>
                  <input
                    type="text"
                    value={reviewVendor}
                    onChange={(e) => setReviewVendor(e.target.value)}
                    className="ff-input w-full text-sm"
                    placeholder="Enter vendor name"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Date</label>
                  <input
                    type="date"
                    value={reviewDate}
                    onChange={(e) => setReviewDate(e.target.value)}
                    className="ff-input w-full text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Reference / Invoice No.</label>
                  <input
                    type="text"
                    value={reviewRef}
                    onChange={(e) => setReviewRef(e.target.value)}
                    className="ff-input w-full text-sm"
                    placeholder="e.g. INV-001"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Total Amount (ZAR)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={reviewTotal}
                    onChange={(e) => setReviewTotal(e.target.value)}
                    className="ff-input w-full text-sm"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">VAT Amount (ZAR)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={reviewVat}
                    onChange={(e) => setReviewVat(e.target.value)}
                    className="ff-input w-full text-sm"
                    placeholder="0.00"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Notes</label>
                  <textarea
                    value={reviewNotes}
                    onChange={(e) => setReviewNotes(e.target.value)}
                    className="ff-input w-full text-sm"
                    rows={2}
                    placeholder="Optional notes..."
                  />
                </div>
              </div>

              {/* Line Items (read-only display) */}
              {uploadResult.extracted.lineItems.length > 0 && (
                <div className="px-6 pb-4">
                  <h3 className="text-xs font-medium text-[var(--ff-text-secondary)] mb-2">Extracted Line Items</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                          <th className="px-3 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Description</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)]">Qty</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)]">Unit Price</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)]">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--ff-border-light)]">
                        {uploadResult.extracted.lineItems.map((item, i) => (
                          <tr key={i}>
                            <td className="px-3 py-2 text-[var(--ff-text-primary)]">{item.description}</td>
                            <td className="px-3 py-2 text-right text-[var(--ff-text-secondary)]">{item.quantity ?? '-'}</td>
                            <td className="px-3 py-2 text-right font-mono text-[var(--ff-text-secondary)]">{item.unitPrice !== null ? formatCurrency(item.unitPrice) : '-'}</td>
                            <td className="px-3 py-2 text-right font-mono text-[var(--ff-text-primary)]">{item.total !== null ? formatCurrency(item.total) : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="px-6 py-4 border-t border-[var(--ff-border-light)] flex items-center gap-3 flex-wrap">
                <button
                  onClick={handleConfirm}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Confirm & Save
                </button>
                <button
                  onClick={handleReject}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-red-600/20 text-red-400 rounded-lg hover:bg-red-600/30 transition-colors text-sm font-medium"
                >
                  <XCircle className="h-4 w-4" />
                  Reject
                </button>
                <button
                  onClick={() => setUploadResult(null)}
                  className="inline-flex items-center gap-2 px-4 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-tertiary)] transition-colors text-sm"
                >
                  Save & Review Later
                </button>
              </div>
            </div>
          )}

          {/* Document List */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] overflow-hidden">
            <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                Captured Documents
                {total > 0 && <span className="text-sm font-normal text-[var(--ff-text-tertiary)] ml-2">({total})</span>}
              </h2>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="ff-select text-sm"
              >
                <option value="">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="reviewed">Reviewed</option>
                <option value="matched">Matched</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 text-teal-500 animate-spin" />
              </div>
            ) : error ? (
              <div className="flex items-center gap-2 justify-center py-12 text-red-400 text-sm">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            ) : documents.length === 0 ? (
              <div className="text-center py-12 text-[var(--ff-text-tertiary)] text-sm">
                No documents captured yet. Upload a PDF above to get started.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                      <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)]">File</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Type</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Vendor</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Date</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Reference</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)]">Total</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-[var(--ff-text-secondary)]">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Uploaded</th>
                      <th className="px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ff-border-light)]">
                    {documents.map((doc) => (
                      <tr key={doc.id} className="hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                            <span className="text-[var(--ff-text-primary)] font-medium truncate max-w-[200px]">
                              {doc.fileName}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-[var(--ff-text-secondary)] capitalize">{doc.documentType || '-'}</td>
                        <td className="px-4 py-3 text-[var(--ff-text-primary)]">{doc.vendorName || '-'}</td>
                        <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{formatDate(doc.documentDate)}</td>
                        <td className="px-4 py-3 text-[var(--ff-text-secondary)] font-mono text-xs">{doc.referenceNumber || '-'}</td>
                        <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(doc.totalAmount ?? 0)}</td>
                        <td className="px-4 py-3 text-center"><StatusBadge status={doc.status} /></td>
                        <td className="px-4 py-3 text-[var(--ff-text-tertiary)] text-xs">{formatDate(doc.createdAt)}</td>
                        <td className="px-4 py-3">
                          <Link
                            href={`/accounting/document-capture/${doc.id}`}
                            className="inline-flex items-center gap-1 text-teal-500 hover:text-teal-400 text-xs"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            View
                            <ChevronRight className="h-3 w-3" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
