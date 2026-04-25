/**
 * Capture Inbox — right-side slide-out detail panel (PRD-05 Phase 1 + Phase 3).
 * Dual-post-path: invoice (existing) + expense claim / direct GL (mig 463).
 */

import { useState, useEffect } from 'react';
import {
  Mail, Smartphone, MessageSquare, Server, Globe,
  Loader2, X, CheckCircle2, Clock, AlertOctagon, Receipt,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

// ─── Shared types (re-exported for page use) ──────────────────────────────────

export interface CaptureEventRow {
  eventId: string;
  companyId?: string;
  inboxId?: string | null;
  receivedAt: string;
  channel: 'email' | 'pwa' | 'whatsapp' | 'imap_mirror' | 'api';
  sender: string | null;
  subject: string | null;
  status: 'received' | 'extracting' | 'extracted' | 'posted' | 'discarded' | 'failed';
  capturedDocumentId: string | null;
  error: string | null;
  postedBy?: string | null;
  postedAt?: string | null;
  vendorName: string | null;
  documentDate: string | null;
  referenceNumber: string | null;
  totalAmount: number | null;
  fileName?: string | null;
  fileType?: string | null;
  documentType: string | null;
  extractedData: Record<string, unknown> | null;
  // Phase 3 gate fields (may be absent on older rows)
  gateOutcome?: 'auto_publish' | 'route_review' | 'duplicate_blocked' | null;
  duplicateHitId?: string | null;
  resolvedSupplierId?: string | null;
  // Dual-post-path (mig 463)
  documentCategory?: 'invoice' | 'expense' | null;
  resolvedEmployeeId?: string | null;
}

interface SupplierRule {
  autoPublish: boolean;
  autoPublishMaxAmount: number | null;
  autoPublishMinConfidence: number;
  requirePoMatch: boolean;
}

type GateStatus = 'auto' | 'review' | 'duplicate' | 'no_rule' | 'not_ready';

interface GateInfo {
  status: GateStatus;
  reason?: string;
  invoiceRef?: string;
}

export interface InboxAddress { id: string; address: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function fmtDate(val: string | Date | null | undefined): string {
  if (!val) return '—';
  try { return new Date(val).toLocaleString('en-ZA'); } catch { return String(val); }
}

export function fmtZAR(val: number | null | undefined): string {
  if (val == null) return '—';
  return `R ${val.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const CHANNEL_ICONS: Record<CaptureEventRow['channel'], React.ReactNode> = {
  email:       <Mail className="h-4 w-4" />,
  pwa:         <Smartphone className="h-4 w-4" />,
  whatsapp:    <MessageSquare className="h-4 w-4" />,
  imap_mirror: <Server className="h-4 w-4" />,
  api:         <Globe className="h-4 w-4" />,
};

// ─── Gate Badge ───────────────────────────────────────────────────────────────

function GateBadge({ gate }: { gate: GateInfo }) {
  if (gate.status === 'not_ready') return null;
  if (gate.status === 'no_rule') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 text-slate-400 text-xs">
        <Clock className="h-3.5 w-3.5 shrink-0" />
        No rule configured for this supplier
      </div>
    );
  }
  if (gate.status === 'duplicate') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/40 text-red-400 text-xs">
        <AlertOctagon className="h-3.5 w-3.5 shrink-0" />
        Duplicate of invoice {gate.invoiceRef ?? gate.reason ?? 'existing record'}
      </div>
    );
  }
  if (gate.status === 'review') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-900/30 text-amber-400 text-xs">
        <Clock className="h-3.5 w-3.5 shrink-0" />
        Routed for review — {gate.reason}
      </div>
    );
  }
  // auto
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-teal-900/30 text-teal-400 text-xs">
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
      Auto-publish eligible
    </div>
  );
}

// ─── Gate hook ────────────────────────────────────────────────────────────────

function useGateInfo(event: CaptureEventRow): GateInfo {
  const [rule, setRule] = useState<SupplierRule | null | undefined>(undefined);
  const supplierId = event.resolvedSupplierId ?? null;

  useEffect(() => {
    if (!supplierId) {
      // Defer to next tick — avoids the "setState synchronously in effect"
      // lint rule that catches cascade-prone patterns.
      const t = setTimeout(() => setRule(null), 0);
      return () => clearTimeout(t);
    }
    let cancelled = false;
    apiFetch(`/api/accounting/supplier-rules/${supplierId}`)
      .then(r => r.status === 404 ? null : r.json() as Promise<{ data?: SupplierRule }>)
      .then(json => { if (!cancelled) setRule(json?.data ?? null); })
      .catch(() => { if (!cancelled) setRule(null); });
    return () => { cancelled = true; };
  }, [supplierId]);

  // Prefer server-supplied gate_outcome when available
  if (event.gateOutcome === 'duplicate_blocked') {
    return { status: 'duplicate', invoiceRef: event.duplicateHitId ?? undefined };
  }

  if (event.status !== 'extracted') return { status: 'not_ready' };
  if (!supplierId) return { status: 'no_rule' };
  if (rule === undefined) return { status: 'not_ready' }; // loading
  if (!rule) return { status: 'no_rule' };
  if (rule.requirePoMatch) return { status: 'review', reason: 'Requires PO match — post to review' };
  if (!rule.autoPublish) return { status: 'review', reason: 'Auto-publish disabled' };

  const confidence = typeof event.extractedData?.confidence === 'number'
    ? (event.extractedData.confidence as number)
    : null;
  if (confidence !== null && confidence < rule.autoPublishMinConfidence) {
    return {
      status: 'review',
      reason: `Confidence ${(confidence * 100).toFixed(0)}% below threshold ${Math.round(rule.autoPublishMinConfidence * 100)}%`,
    };
  }
  const total = event.totalAmount ?? null;
  if (total !== null && rule.autoPublishMaxAmount !== null && total > rule.autoPublishMaxAmount) {
    return {
      status: 'review',
      reason: `Amount ${fmtZAR(total)} over cap ${fmtZAR(rule.autoPublishMaxAmount)}`,
    };
  }
  return { status: 'auto' };
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

export function StatusBadge({ status, error }: { status: CaptureEventRow['status']; error: string | null }) {
  const map: Record<string, string> = {
    received:   'bg-slate-700 text-slate-300',
    extracting: 'bg-yellow-900/50 text-yellow-300',
    extracted:  'bg-blue-900/50 text-blue-300',
    posted:     'bg-green-900/50 text-green-300',
    discarded:  'bg-slate-800 text-slate-500',
    failed:     'bg-red-900/50 text-red-300',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? map.received}`}>
      {status === 'extracting' && <Loader2 className="h-3 w-3 animate-spin" />}
      {status.charAt(0).toUpperCase() + status.slice(1)}
      {status === 'failed' && error && <span className="ml-1 text-red-400" title={error}>!</span>}
    </span>
  );
}

// ─── Row helper ───────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-24 shrink-0 text-slate-500">{label}</span>
      <span className="text-slate-200 break-words">{value}</span>
    </div>
  );
}

// ─── Side Panel ───────────────────────────────────────────────────────────────

interface Employee { id: string; name: string }

interface SidePanelProps {
  event: CaptureEventRow;
  onClose: () => void;
  onPost: (id: string) => Promise<void>;
  onDiscard: (id: string, reason?: string) => Promise<void>;
  onPostExpense: (id: string, employeeId?: string, glAccountId?: string) => Promise<void>;
  posting: boolean;
  discarding: boolean;
}

// ─── Document Category Badge ──────────────────────────────────────────────────

function CategoryBadge({ category }: { category: 'invoice' | 'expense' | null | undefined }) {
  if (!category) return null;
  if (category === 'expense') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-900/40 text-amber-300">
        <Receipt className="h-3 w-3" />
        Expense Receipt
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-900/40 text-blue-300">
      Invoice
    </span>
  );
}

export function CaptureInboxPanel({ event, onClose, onPost, onDiscard, onPostExpense, posting, discarding }: SidePanelProps) {
  const [discardMode, setDiscardMode] = useState(false);
  const [discardReason, setDiscardReason] = useState('');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const gate = useGateInfo(event);
  const ed = event.extractedData;
  const lineItems = Array.isArray(ed?.line_items) ? (ed.line_items as Record<string, unknown>[]) : null;

  // Fetch employees for expense path
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/payroll/employees?limit=200')
      .then(r => r.ok ? r.json() as Promise<{ data?: unknown }> : Promise.resolve({ data: undefined }))
      .then(json => {
        if (cancelled) return;
        const rows = Array.isArray(json.data) ? json.data as Record<string, unknown>[] : [];
        setEmployees(rows.map(r => ({
          id: String(r.id ?? r.employee_id ?? ''),
          name: [r.first_name, r.last_name].filter(Boolean).join(' ') || String(r.name ?? r.id ?? ''),
        })).filter(e => e.id));
      })
      .catch(() => { /* non-critical */ });
    return () => { cancelled = true; };
  }, []);

  // Decide if this event should show the expense post section
  const isExpenseDoc = event.documentCategory === 'expense' ||
    (event.status === 'extracted' && !event.resolvedSupplierId && !event.referenceNumber);

  return (
    <div className="fixed inset-y-0 right-0 w-[420px] bg-[var(--ff-canvas-mid)] border-l border-[rgba(255,255,255,0.08)] shadow-2xl flex flex-col z-50">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[rgba(255,255,255,0.08)]">
        <div className="flex items-center gap-2 text-slate-300 flex-wrap">
          {CHANNEL_ICONS[event.channel]}
          <span className="font-medium capitalize">{event.channel.replace('_', ' ')}</span>
          <StatusBadge status={event.status} error={event.error} />
          <CategoryBadge category={event.documentCategory} />
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors">
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-sm">
        <div className="space-y-1.5">
          <Row label="Received" value={fmtDate(event.receivedAt)} />
          <Row label="Sender"   value={event.sender ?? '—'} />
          <Row label="Subject"  value={event.subject ?? '—'} />
        </div>

        {(event.vendorName || event.referenceNumber || event.totalAmount != null) && (
          <div className="border-t border-[rgba(255,255,255,0.06)] pt-4 space-y-1.5">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Extracted Document</p>
            <Row label="Vendor"    value={event.vendorName ?? '—'} />
            <Row label="Type"      value={event.documentType ?? '—'} />
            <Row label="Reference" value={event.referenceNumber ?? '—'} />
            <Row label="Date"      value={fmtDate(event.documentDate)} />
            <Row label="Total"     value={fmtZAR(event.totalAmount)} />
            {ed?.subtotal != null   && <Row label="Subtotal" value={fmtZAR(ed.subtotal as number)} />}
            {ed?.vat_amount != null && <Row label="VAT"      value={fmtZAR(ed.vat_amount as number)} />}
          </div>
        )}

        {lineItems && lineItems.length > 0 && (
          <div className="border-t border-[rgba(255,255,255,0.06)] pt-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Line Items</p>
            <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
              {lineItems.map((li, i) => (
                <div key={i} className="flex items-center justify-between py-1 px-2 rounded bg-white/5 text-slate-300">
                  <span className="truncate flex-1 mr-2">{String(li.description ?? li.item ?? `Item ${i + 1}`)}</span>
                  <span className="shrink-0 text-slate-400">{fmtZAR(li.amount as number ?? null)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {event.status === 'failed' && event.error && (
          <div className="border-t border-[rgba(255,255,255,0.06)] pt-4">
            <p className="text-xs font-semibold text-red-500 uppercase tracking-wider mb-1">Error</p>
            <p className="text-red-400 text-xs font-mono whitespace-pre-wrap break-words">{event.error}</p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-5 py-4 border-t border-[rgba(255,255,255,0.08)] space-y-2">
        {/* Gate badge — shown above buttons when event is extracted */}
        {event.status === 'extracted' && gate.status !== 'not_ready' && (
          <GateBadge gate={gate} />
        )}

        {discardMode ? (
          <div className="space-y-2">
            <input
              value={discardReason}
              onChange={e => setDiscardReason(e.target.value)}
              placeholder="Reason (optional)"
              className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 text-sm placeholder:text-slate-600 focus:outline-none focus:border-teal-500"
            />
            <div className="flex gap-2">
              <button onClick={() => { void onDiscard(event.eventId, discardReason || undefined); setDiscardMode(false); }}
                disabled={discarding}
                className="flex-1 px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded text-sm font-medium">
                {discarding ? <Loader2 className="h-4 w-4 animate-spin mx-auto" /> : 'Confirm Discard'}
              </button>
              <button onClick={() => setDiscardMode(false)} className="px-4 py-2 rounded text-sm text-slate-400 hover:text-slate-200">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Expense path — shown when document is classified as an expense or no supplier resolved */}
            {isExpenseDoc && event.status === 'extracted' && (
              <div className="space-y-2 p-3 rounded-lg bg-amber-900/10 border border-amber-900/30">
                <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Receipt className="h-3.5 w-3.5" />
                  Post as Expense
                </p>
                <select
                  value={selectedEmployeeId}
                  onChange={e => setSelectedEmployeeId(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 text-sm focus:outline-none focus:border-amber-500"
                >
                  <option value="">— No employee (post direct to GL) —</option>
                  {employees.map(emp => (
                    <option key={emp.id} value={emp.id}>{emp.name}</option>
                  ))}
                </select>
                <button
                  onClick={() => void onPostExpense(event.eventId, selectedEmployeeId || undefined)}
                  disabled={posting}
                  className="w-full px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white rounded text-sm font-medium transition-colors flex items-center justify-center gap-2"
                >
                  {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Receipt className="h-4 w-4" />}
                  {posting ? 'Posting…' : 'Post as Expense'}
                </button>
              </div>
            )}

            {/* Invoice path — shown when doc is invoice type or has a resolved supplier */}
            {(event.documentCategory === 'invoice' || !isExpenseDoc || event.resolvedSupplierId) && (
              <div className="flex gap-2">
                {gate.status === 'duplicate' ? (
                  <button disabled title={`Duplicate of ${gate.invoiceRef ?? 'existing record'}`}
                    className="flex-1 px-4 py-2 bg-red-900/30 opacity-60 cursor-not-allowed text-red-400 rounded text-sm font-medium">
                    Blocked — duplicate
                  </button>
                ) : gate.status === 'auto' ? (
                  <button onClick={() => void onPost(event.eventId)} disabled={posting || event.status !== 'extracted'}
                    className="flex-1 px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white rounded text-sm font-medium transition-colors">
                    {posting ? <Loader2 className="h-4 w-4 animate-spin mx-auto" /> : 'Auto-post'}
                  </button>
                ) : (
                  <button onClick={() => void onPost(event.eventId)} disabled={posting || event.status !== 'extracted'}
                    className="flex-1 px-4 py-2 bg-white/10 hover:bg-white/15 disabled:opacity-40 text-slate-200 rounded text-sm font-medium transition-colors border border-[rgba(255,255,255,0.1)]">
                    {posting ? <Loader2 className="h-4 w-4 animate-spin mx-auto" /> : 'Post to review'}
                  </button>
                )}
                <button onClick={() => setDiscardMode(true)} disabled={discarding}
                  className="px-4 py-2 bg-white/5 hover:bg-white/10 text-slate-300 rounded text-sm font-medium transition-colors">
                  Discard
                </button>
              </div>
            )}

            {/* Stand-alone Discard when only expense path is shown */}
            {isExpenseDoc && event.documentCategory !== 'invoice' && !event.resolvedSupplierId && (
              <button onClick={() => setDiscardMode(true)} disabled={discarding}
                className="w-full px-4 py-2 bg-white/5 hover:bg-white/10 text-slate-300 rounded text-sm font-medium transition-colors">
                Discard
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
