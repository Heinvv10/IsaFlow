import { FileText, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';
import type { CapturedDocument, ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

interface ReviewForm {
  vendor: string;
  date: string;
  ref: string;
  total: string;
  vat: string;
  docType: string;
  notes: string;
}

interface Props {
  uploadResult: { document: CapturedDocument; extracted: ExtractedDocument };
  form: ReviewForm;
  onChange: (field: keyof ReviewForm, value: string) => void;
  onDismiss: () => void;
  onRefreshList: () => void;
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  let color = 'text-red-400';
  let label = 'Low';
  if (confidence >= 0.7) { color = 'text-teal-400'; label = 'High'; }
  else if (confidence >= 0.4) { color = 'text-amber-400'; label = 'Medium'; }
  return <span className={`text-xs font-medium ${color}`}>{label} ({Math.round(confidence * 100)}%)</span>;
}

export function ExtractionReview({ uploadResult, form, onChange, onDismiss, onRefreshList }: Props) {
  async function handleConfirm() {
    try {
      const res = await apiFetch('/api/accounting/document-capture-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: uploadResult.document.id,
          action: 'confirm',
          data: {
            vendorName: form.vendor || null,
            documentDate: form.date || null,
            referenceNumber: form.ref || null,
            totalAmount: form.total ? parseFloat(form.total) : null,
            vatAmount: form.vat ? parseFloat(form.vat) : null,
            documentType: form.docType || null,
            notes: form.notes || null,
          },
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Confirm failed');
      notify.success('Document confirmed');
      onDismiss();
      onRefreshList();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Confirm failed');
    }
  }

  async function handleReject() {
    try {
      const res = await apiFetch('/api/accounting/document-capture-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: uploadResult.document.id,
          action: 'reject',
          data: { notes: form.notes || 'Rejected during review' },
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Reject failed');
      notify.success('Document rejected');
      onDismiss();
      onRefreshList();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Reject failed');
    }
  }

  const { extracted } = uploadResult;

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] overflow-hidden">
      <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileText className="h-5 w-5 text-teal-500" />
          <div>
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Extraction Results</h2>
            <p className="text-xs text-[var(--ff-text-secondary)]">{uploadResult.document.fileName}</p>
          </div>
        </div>
        <ConfidenceBadge confidence={extracted.confidence} />
      </div>

      {extracted.warnings.length > 0 && (
        <div className="px-6 py-3 bg-amber-500/5 border-b border-[var(--ff-border-light)]">
          {extracted.warnings.map((w, i) => (
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
          <select value={form.docType} onChange={(e) => onChange('docType', e.target.value)} className="ff-select w-full text-sm">
            <option value="invoice">Invoice</option>
            <option value="credit_note">Credit Note</option>
            <option value="receipt">Receipt</option>
            <option value="statement">Statement</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Vendor Name</label>
          <input type="text" value={form.vendor} onChange={(e) => onChange('vendor', e.target.value)} className="ff-input w-full text-sm" placeholder="Enter vendor name" />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Date</label>
          <input type="date" value={form.date} onChange={(e) => onChange('date', e.target.value)} className="ff-input w-full text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Reference / Invoice No.</label>
          <input type="text" value={form.ref} onChange={(e) => onChange('ref', e.target.value)} className="ff-input w-full text-sm" placeholder="e.g. INV-001" />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Total Amount (ZAR)</label>
          <input type="number" step="0.01" value={form.total} onChange={(e) => onChange('total', e.target.value)} className="ff-input w-full text-sm" placeholder="0.00" />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">VAT Amount (ZAR)</label>
          <input type="number" step="0.01" value={form.vat} onChange={(e) => onChange('vat', e.target.value)} className="ff-input w-full text-sm" placeholder="0.00" />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Notes</label>
          <textarea value={form.notes} onChange={(e) => onChange('notes', e.target.value)} className="ff-input w-full text-sm" rows={2} placeholder="Optional notes..." />
        </div>
      </div>

      {extracted.lineItems.length > 0 && (
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

      <div className="px-6 py-4 border-t border-[var(--ff-border-light)] flex items-center gap-3 flex-wrap">
        <button onClick={handleConfirm} className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium">
          <CheckCircle2 className="h-4 w-4" /> Confirm & Save
        </button>
        <button onClick={handleReject} className="inline-flex items-center gap-2 px-4 py-2 bg-red-600/20 text-red-400 rounded-lg hover:bg-red-600/30 transition-colors text-sm font-medium">
          <XCircle className="h-4 w-4" /> Reject
        </button>
        <button onClick={onDismiss} className="inline-flex items-center gap-2 px-4 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-tertiary)] transition-colors text-sm">
          Save & Review Later
        </button>
      </div>
    </div>
  );
}
