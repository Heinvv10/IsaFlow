/**
 * WIP & Billing Board
 * Route: /accounting/practice/wip
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { WipClientRow, GenerateWipInvoiceInput } from '@/modules/accounting/services/practice/practiceWipService';

function todayIso() { return new Date().toISOString().slice(0, 10); }
function fmtMoney(n: number) { return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n); }
function fmtDate(iso: string) { return iso ? new Date(iso).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'; }

const TH = 'text-left py-2 px-3 text-[10px] tracking-widest font-semibold text-[var(--ff-text-secondary)] uppercase';
const TD = 'py-2 px-3 text-sm text-[var(--ff-text-secondary)]';
const RING = 'focus:outline-none focus:ring-2 focus:ring-teal-500/40';
const INPUT_CLS = `w-full rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] px-3 py-2 text-sm text-[var(--ff-text-primary)] ${RING}`;

function ErrBanner({ msg }: { msg: string }) {
  return <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm"><AlertCircle className="h-4 w-4 shrink-0" />{msg}</div>;
}

function TriCheckbox({ state, onChange }: { state: 'none' | 'some' | 'all'; onChange: () => void }) {
  const r = useRef<HTMLInputElement>(null);
  useEffect(() => { if (r.current) { r.current.indeterminate = state === 'some'; r.current.checked = state === 'all'; } }, [state]);
  return <input ref={r} type="checkbox" className="h-4 w-4 rounded accent-teal-500 cursor-pointer" onChange={onChange} />;
}

// ---- client group accordion ----

interface GroupProps {
  group: WipClientRow; selectedIds: Set<string>; expanded: boolean;
  onToggleExpand: () => void; onToggleAll: () => void;
  onToggleEntry: (id: string) => void; onGenerate: () => void;
}

function WipClientGroup({ group, selectedIds, expanded, onToggleExpand, onToggleAll, onToggleEntry, onGenerate }: GroupProps) {
  const selCount = selectedIds.size;
  const checkState: 'none' | 'some' | 'all' = selCount === 0 ? 'none' : selCount === group.entries.length ? 'all' : 'some';
  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-[var(--ff-bg-tertiary)] transition-colors" onClick={onToggleExpand}>
        <div onClick={(e) => e.stopPropagation()}><TriCheckbox state={checkState} onChange={onToggleAll} /></div>
        <span className="text-[var(--ff-text-tertiary)]">{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
        <span className="flex-1 font-semibold text-[var(--ff-text-primary)] text-sm">{group.legalName}</span>
        <span className="text-sm text-[var(--ff-text-secondary)] tabular-nums">{group.totalHours.toFixed(2)}h</span>
        <span className="text-sm font-medium text-[var(--ff-text-primary)] tabular-nums w-28 text-right">{fmtMoney(group.totalValue)}</span>
        <span className="text-xs text-[var(--ff-text-tertiary)] w-36 text-right hidden lg:block">Oldest: {fmtDate(group.oldestApprovedDate)}</span>
        <div onClick={(e) => e.stopPropagation()} className="ml-2">
          {group.linkCustomerId != null
            ? <button disabled={selCount === 0} onClick={onGenerate} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-teal-600 hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"><FileText className="h-3.5 w-3.5" />Generate Invoice</button>
            : <Link href={`/accounting/practice/clients/${group.practiceClientId}`} className="text-xs text-amber-400 hover:text-amber-300 underline underline-offset-2">Set linked customer →</Link>}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-[var(--ff-border-primary)] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--ff-bg-tertiary)]">
                <th className="py-2 px-3 w-8" /><th className={TH}>Date</th><th className={TH}>Category / Work Item</th>
                <th className={TH}>Description</th><th className={`${TH} text-right`}>Hrs</th>
                <th className={`${TH} text-right`}>Rate</th><th className={`${TH} text-right`}>Total</th>
              </tr>
            </thead>
            <tbody>
              {group.entries.map((e) => (
                <tr key={e.id} onClick={() => onToggleEntry(e.id)} className="border-t border-[var(--ff-border-primary)] hover:bg-[var(--ff-bg-tertiary)]/50 cursor-pointer transition-colors">
                  <td className="py-2 px-3"><input type="checkbox" readOnly checked={selectedIds.has(e.id)} className="h-4 w-4 rounded accent-teal-500 cursor-pointer" /></td>
                  <td className={TD}>{fmtDate(e.entryDate)}</td>
                  <td className={TD}>{e.jobCategoryName ?? '—'}{e.workItemName && <span className="text-[var(--ff-text-tertiary)]"> / {e.workItemName}</span>}</td>
                  <td className={`${TD} max-w-xs truncate`}>{e.taskDescription}</td>
                  <td className={`${TD} text-right tabular-nums`}>{e.hours.toFixed(2)}h</td>
                  <td className={`${TD} text-right tabular-nums`}>{e.appliedRate != null ? fmtMoney(e.appliedRate) : '—'}</td>
                  <td className={`${TD} text-right tabular-nums font-medium text-[var(--ff-text-primary)]`}>{e.lineTotal != null ? fmtMoney(e.lineTotal) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- invoice modal ----

type ModalState = { invoiceDate: string; taxRate: number; groupBy: string };

interface ModalProps {
  client: WipClientRow; selectedIds: Set<string>; state: ModalState;
  onChange: (p: Partial<ModalState>) => void;
  onConfirm: () => void; onCancel: () => void;
  loading: boolean; error: string | null;
}

function InvoiceModal({ client, selectedIds, state, onChange, onConfirm, onCancel, loading, error }: ModalProps) {
  const subtotal = client.entries.filter((e) => selectedIds.has(e.id)).reduce((s, e) => s + (e.lineTotal ?? 0), 0);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] shadow-2xl">
        <div className="px-6 py-4 border-b border-[var(--ff-border-primary)]">
          <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Generate Invoice for {client.legalName}</h2>
          <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">{selectedIds.size} entr{selectedIds.size === 1 ? 'y' : 'ies'} · {fmtMoney(subtotal)} subtotal</p>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && <ErrBanner msg={error} />}
          <div>
            <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Invoice Date</label>
            <input type="date" value={state.invoiceDate} onChange={(e) => onChange({ invoiceDate: e.target.value })} className={INPUT_CLS} />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Tax Rate (%)</label>
            <input type="number" min={0} max={100} step={0.1} value={state.taxRate} onChange={(e) => onChange({ taxRate: parseFloat(e.target.value) || 0 })} className={INPUT_CLS} />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-2">Grouping</label>
            <div className="space-y-1.5">
              {([['detailed','Detailed (one line per entry)'],['by_work_item','By work item'],['by_category','By category']] as [string,string][]).map(([v,l]) => (
                <label key={v} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="groupBy" value={v} checked={state.groupBy === v} onChange={() => onChange({ groupBy: v })} className="accent-teal-500" />
                  <span className="text-sm text-[var(--ff-text-primary)]">{l}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-[var(--ff-border-primary)] flex justify-end gap-3">
          <button onClick={onCancel} disabled={loading} className="px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] transition-colors disabled:opacity-50">Cancel</button>
          <button onClick={onConfirm} disabled={loading} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors">
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}{loading ? 'Generating…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- page ----

type GroupBy = 'detailed' | 'by_work_item' | 'by_category';
type InvoiceResult = { invoiceId: string; invoiceNumber: string; totalAmount: number };

export default function WipBoardPage() {
  const [groups, setGroups] = useState<WipClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [modalClient, setModalClient] = useState<WipClientRow | null>(null);
  const [modalState, setModalState] = useState<{ invoiceDate: string; taxRate: number; groupBy: string }>({ invoiceDate: todayIso(), taxRate: 15, groupBy: 'detailed' });
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; href: string } | null>(null);

  const loadWip = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const res = await apiFetch('/api/accounting/practice/wip');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: WipClientRow[] } | WipClientRow[];
      setGroups(Array.isArray(json) ? json : (json.data ?? []));
      setSelected({});
    } catch (err) { setLoadError(err instanceof Error ? err.message : 'Failed to load WIP data'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadWip(); }, [loadWip]);

  function toggleExpand(id: string) { setExpanded((p) => ({ ...p, [id]: !p[id] })); }

  function toggleAll(group: WipClientRow) {
    setSelected((p) => {
      const cur = p[group.practiceClientId] ?? new Set<string>();
      const next = cur.size < group.entries.length ? new Set(group.entries.map((e) => e.id)) : new Set<string>();
      return { ...p, [group.practiceClientId]: next };
    });
  }

  function toggleEntry(clientId: string, entryId: string) {
    setSelected((p) => {
      const cur = new Set(p[clientId] ?? []);
      cur.has(entryId) ? cur.delete(entryId) : cur.add(entryId);
      return { ...p, [clientId]: cur };
    });
  }

  async function handleConfirmInvoice() {
    if (!modalClient) return;
    const ids = [...(selected[modalClient.practiceClientId] ?? [])];
    if (!ids.length) return;
    setModalLoading(true); setModalError(null);
    try {
      const input: GenerateWipInvoiceInput = { practiceClientId: modalClient.practiceClientId, timeEntryIds: ids, invoiceDate: modalState.invoiceDate, taxRate: modalState.taxRate, groupBy: modalState.groupBy as GroupBy };
      const res = await apiFetch('/api/accounting/practice/wip/invoice', { method: 'POST', body: JSON.stringify(input) });
      const json = (await res.json()) as { data?: InvoiceResult; error?: string } & InvoiceResult;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const r: InvoiceResult = json.data ?? json;
      setToast({ message: `Invoice ${r.invoiceNumber} created (${fmtMoney(r.totalAmount)})`, href: `/accounting/customer-invoices?id=${r.invoiceId}` });
      setModalClient(null);
      setModalState({ invoiceDate: todayIso(), taxRate: 15, groupBy: 'detailed' });
      await loadWip();
    } catch (err) { setModalError(err instanceof Error ? err.message : 'Invoice generation failed'); }
    finally { setModalLoading(false); }
  }

  const totHours = groups.reduce((s, g) => s + g.totalHours, 0);
  const totValue = groups.reduce((s, g) => s + g.totalValue, 0);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10"><FileText className="h-5 w-5 text-teal-400" /></div>
            <div>
              <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Work in Progress</h1>
              {!loading && !loadError && <p className="text-xs text-[var(--ff-text-tertiary)]">{groups.length} client{groups.length !== 1 ? 's' : ''} · {totHours.toFixed(2)}h unbilled · {fmtMoney(totValue)} total</p>}
            </div>
          </div>
        </div>
        <div className="px-6 py-6 space-y-4 max-w-7xl">
          {toast && (
            <div className="flex items-center justify-between p-3 rounded-lg bg-teal-500/10 border border-teal-500/20 text-teal-300 text-sm">
              <span>{toast.message} — <Link href={toast.href} className="underline underline-offset-2 hover:text-teal-200">View invoice</Link></span>
              <button onClick={() => setToast(null)} className="ml-4 text-teal-400 hover:text-teal-200 text-lg leading-none">×</button>
            </div>
          )}
          {loadError && <ErrBanner msg={loadError} />}
          {loading
            ? <div className="flex items-center gap-2 py-12 justify-center text-[var(--ff-text-tertiary)] text-sm"><Loader2 className="h-5 w-5 animate-spin" />Loading WIP data…</div>
            : groups.length === 0
              ? <p className="py-16 text-center text-[var(--ff-text-tertiary)] text-sm">No unbilled approved time entries found.</p>
              : groups.map((g) => (
                <WipClientGroup key={g.practiceClientId} group={g}
                  selectedIds={selected[g.practiceClientId] ?? new Set()}
                  expanded={expanded[g.practiceClientId] ?? false}
                  onToggleExpand={() => toggleExpand(g.practiceClientId)}
                  onToggleAll={() => toggleAll(g)}
                  onToggleEntry={(id) => toggleEntry(g.practiceClientId, id)}
                  onGenerate={() => { setModalClient(g); setModalError(null); }}
                />
              ))
          }
        </div>
      </div>
      {modalClient && (
        <InvoiceModal client={modalClient} selectedIds={selected[modalClient.practiceClientId] ?? new Set()}
          state={modalState} onChange={(p) => setModalState((prev) => ({ ...prev, ...p }))}
          onConfirm={() => void handleConfirmInvoice()} onCancel={() => { setModalClient(null); setModalError(null); }}
          loading={modalLoading} error={modalError} />
      )}
    </AppLayout>
  );
}
