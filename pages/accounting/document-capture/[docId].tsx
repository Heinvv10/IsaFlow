/**
 * Document Capture Detail Page
 * View extracted data, edit fields, take actions on a captured document.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ScanLine, ArrowLeft, Loader2, AlertCircle, FileText,
  CheckCircle2, XCircle, Link2, Save, ChevronDown, ChevronUp,
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
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
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

export default function DocumentCaptureDetailPage() {
  const router = useRouter();
  const { docId } = router.query;

  const [doc, setDoc] = useState<CapturedDocument | null>(null);
  const [extracted, setExtracted] = useState<ExtractedDocument | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [showRawText, setShowRawText] = useState(false);

  // Editable fields
  const [vendorName, setVendorName] = useState('');
  const [documentDate, setDocumentDate] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [totalAmount, setTotalAmount] = useState('');
  const [vatAmount, setVatAmount] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [notes, setNotes] = useState('');

  // Bank TX match
  const [bankTxId, setBankTxId] = useState('');
  const [isMatching, setIsMatching] = useState(false);

  const loadDocument = useCallback(async () => {
    if (!docId) return;
    setIsLoading(true);
    setError('');

    try {
      const res = await apiFetch(`/api/accounting/document-capture?status=`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Failed to load');

      const found = (json.data || []).find((d: CapturedDocument) => d.id === docId);
      if (!found) throw new Error('Document not found');

      setDoc(found);

      const ext = found.extractedData as ExtractedDocument | null;
      setExtracted(ext);

      // Populate form
      setVendorName(found.vendorName || ext?.vendorName || '');
      setDocumentDate(found.documentDate || ext?.date || '');
      setReferenceNumber(found.referenceNumber || ext?.referenceNumber || '');
      setTotalAmount(found.totalAmount !== null ? String(found.totalAmount) : (ext?.totalAmount !== null ? String(ext?.totalAmount) : ''));
      setVatAmount(found.vatAmount !== null ? String(found.vatAmount) : (ext?.vatAmount !== null ? String(ext?.vatAmount) : ''));
      setDocumentType(found.documentType || ext?.documentType || 'unknown');
      setNotes(found.notes || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load document');
    } finally {
      setIsLoading(false);
    }
  }, [docId]);

  useEffect(() => { loadDocument(); }, [loadDocument]);

  async function handleConfirm() {
    if (!doc) return;
    setIsSaving(true);
    try {
      const res = await apiFetch('/api/accounting/document-capture-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: doc.id,
          action: 'confirm',
          data: {
            vendorName: vendorName || null,
            documentDate: documentDate || null,
            referenceNumber: referenceNumber || null,
            totalAmount: totalAmount ? parseFloat(totalAmount) : null,
            vatAmount: vatAmount ? parseFloat(vatAmount) : null,
            documentType: documentType || null,
            notes: notes || null,
          },
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Confirm failed');
      notify.success('Document confirmed');
      loadDocument();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Confirm failed');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleReject() {
    if (!doc) return;
    setIsSaving(true);
    try {
      const res = await apiFetch('/api/accounting/document-capture-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: doc.id,
          action: 'reject',
          data: { notes: notes || 'Rejected' },
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Reject failed');
      notify.success('Document rejected');
      loadDocument();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleMatchBankTx() {
    if (!doc || !bankTxId.trim()) {
      notify.error('Enter a bank transaction ID');
      return;
    }
    setIsMatching(true);
    try {
      const res = await apiFetch('/api/accounting/document-capture-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: doc.id,
          action: 'match_bank_tx',
          data: { bankTxId: bankTxId.trim() },
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Match failed');
      notify.success('Matched to bank transaction');
      setBankTxId('');
      loadDocument();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Match failed');
    } finally {
      setIsMatching(false);
    }
  }

  if (isLoading) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <Loader2 className="h-8 w-8 text-teal-500 animate-spin" />
        </div>
      </AppLayout>
    );
  }

  if (error || !doc) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex flex-col items-center justify-center gap-4">
          <AlertCircle className="h-8 w-8 text-red-400" />
          <p className="text-red-400 text-sm">{error || 'Document not found'}</p>
          <Link href="/accounting/document-capture" className="text-teal-500 hover:text-teal-400 text-sm">
            Back to Document Capture
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link
                href="/accounting/document-capture"
                className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)] transition-colors"
              >
                <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
              </Link>
              <div className="p-2 rounded-lg bg-teal-500/10">
                <ScanLine className="h-5 w-5 text-teal-500" />
              </div>
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-xl font-bold text-[var(--ff-text-primary)]">
                    {doc.fileName}
                  </h1>
                  <StatusBadge status={doc.status} />
                </div>
                <p className="text-xs text-[var(--ff-text-tertiary)]">
                  Uploaded {formatDate(doc.createdAt)}
                  {doc.fileSize ? ` - ${(doc.fileSize / 1024).toFixed(1)} KB` : ''}
                </p>
              </div>
            </div>
            {extracted && <ConfidenceBadge confidence={extracted.confidence} />}
          </div>
        </div>

        <div className="p-6 space-y-6 max-w-4xl mx-auto">
          {/* Warnings */}
          {extracted && extracted.warnings.length > 0 && (
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-4">
              {extracted.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-sm text-amber-400">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {/* Edit Form */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)]">
            <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Document Details</h2>
              <p className="text-xs text-[var(--ff-text-tertiary)]">Review and correct the extracted fields</p>
            </div>
            <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Document Type</label>
                <select
                  value={documentType}
                  onChange={(e) => setDocumentType(e.target.value)}
                  className="ff-select w-full text-sm"
                  disabled={doc.status === 'rejected'}
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
                  value={vendorName}
                  onChange={(e) => setVendorName(e.target.value)}
                  className="ff-input w-full text-sm"
                  placeholder="Enter vendor name"
                  disabled={doc.status === 'rejected'}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Date</label>
                <input
                  type="date"
                  value={documentDate}
                  onChange={(e) => setDocumentDate(e.target.value)}
                  className="ff-input w-full text-sm"
                  disabled={doc.status === 'rejected'}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Reference / Invoice No.</label>
                <input
                  type="text"
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  className="ff-input w-full text-sm"
                  placeholder="e.g. INV-001"
                  disabled={doc.status === 'rejected'}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Total Amount (ZAR)</label>
                <input
                  type="number"
                  step="0.01"
                  value={totalAmount}
                  onChange={(e) => setTotalAmount(e.target.value)}
                  className="ff-input w-full text-sm"
                  placeholder="0.00"
                  disabled={doc.status === 'rejected'}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">VAT Amount (ZAR)</label>
                <input
                  type="number"
                  step="0.01"
                  value={vatAmount}
                  onChange={(e) => setVatAmount(e.target.value)}
                  className="ff-input w-full text-sm"
                  placeholder="0.00"
                  disabled={doc.status === 'rejected'}
                />
              </div>
              {extracted?.vendorVatNumber && (
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Vendor VAT Number</label>
                  <input
                    type="text"
                    value={extracted.vendorVatNumber}
                    className="ff-input w-full text-sm bg-[var(--ff-bg-tertiary)]"
                    readOnly
                  />
                </div>
              )}
              {extracted?.subtotal !== null && extracted?.subtotal !== undefined && (
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Subtotal (extracted)</label>
                  <input
                    type="text"
                    value={formatCurrency(extracted.subtotal)}
                    className="ff-input w-full text-sm bg-[var(--ff-bg-tertiary)]"
                    readOnly
                  />
                </div>
              )}
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="ff-input w-full text-sm"
                  rows={2}
                  placeholder="Optional notes..."
                  disabled={doc.status === 'rejected'}
                />
              </div>
            </div>

            {/* Line Items */}
            {extracted && extracted.lineItems.length > 0 && (
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
                      {extracted.lineItems.map((item, i) => (
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
            {doc.status !== 'rejected' && (
              <div className="px-6 py-4 border-t border-[var(--ff-border-light)] flex items-center gap-3 flex-wrap">
                <button
                  onClick={handleConfirm}
                  disabled={isSaving}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium disabled:opacity-50"
                >
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  {doc.status === 'reviewed' ? 'Update' : 'Confirm & Save'}
                </button>
                <button
                  onClick={handleReject}
                  disabled={isSaving}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-red-600/20 text-red-400 rounded-lg hover:bg-red-600/30 transition-colors text-sm font-medium disabled:opacity-50"
                >
                  <XCircle className="h-4 w-4" />
                  Reject
                </button>
              </div>
            )}
          </div>

          {/* Match to Bank Transaction */}
          {doc.status !== 'rejected' && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)]">
              <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Match to Bank Transaction</h2>
                <p className="text-xs text-[var(--ff-text-tertiary)]">Link this document to a bank transaction for reconciliation</p>
              </div>
              <div className="p-6">
                {doc.matchedBankTxId ? (
                  <div className="flex items-center gap-2 text-sm text-teal-400">
                    <Link2 className="h-4 w-4" />
                    Matched to bank transaction: <span className="font-mono text-xs">{doc.matchedBankTxId}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <input
                      type="text"
                      value={bankTxId}
                      onChange={(e) => setBankTxId(e.target.value)}
                      className="ff-input flex-1 text-sm"
                      placeholder="Enter bank transaction ID..."
                    />
                    <button
                      onClick={handleMatchBankTx}
                      disabled={isMatching || !bankTxId.trim()}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium disabled:opacity-50"
                    >
                      {isMatching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                      Match
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Raw Text Preview */}
          {extracted?.rawText && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)]">
              <button
                onClick={() => setShowRawText(!showRawText)}
                className="w-full px-6 py-4 flex items-center justify-between text-left"
              >
                <div>
                  <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Raw Extracted Text</h2>
                  <p className="text-xs text-[var(--ff-text-tertiary)]">The full text extracted from the PDF</p>
                </div>
                {showRawText ? (
                  <ChevronUp className="h-5 w-5 text-[var(--ff-text-tertiary)]" />
                ) : (
                  <ChevronDown className="h-5 w-5 text-[var(--ff-text-tertiary)]" />
                )}
              </button>
              {showRawText && (
                <div className="px-6 pb-6">
                  <pre className="bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded-lg p-4 text-xs text-[var(--ff-text-secondary)] whitespace-pre-wrap font-mono max-h-96 overflow-y-auto">
                    {extracted.rawText}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
