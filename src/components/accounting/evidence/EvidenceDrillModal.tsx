/**
 * EvidenceDrillModal
 * Shared modal for Evidence drill-down from Trial Balance, Income Statement, Balance Sheet.
 * Fetches /api/accounting/evidence/trial-balance/[accountId] then drills into individual JEs.
 */

import { useState, useEffect, useCallback } from 'react';
import { X, Loader2, AlertCircle, FileText, ExternalLink } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

export interface AccountEvidenceRow {
  je_id: string;
  entry_date: string;
  entry_number: string | null;
  description: string | null;
  debit: number;
  credit: number;
  posting_agent: string | null;
  extraction_confidence: number | null;
  source_document_id: string | null;
  document_vendor: string | null;
  document_reference: string | null;
  document_date: string | null;
  document_thumbnail_url: string | null;
}

interface JEDetail {
  je: Record<string, unknown>;
  lines: Record<string, unknown>[];
  document: {
    vendor?: string | null;
    reference?: string | null;
    thumbnail_url?: string | null;
    extraction_confidence?: number | null;
  } | null;
}

interface Props {
  accountId: string;
  accountName: string;
  periodStart: string;
  periodEnd: string;
  onClose: () => void;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

import type { ReactElement } from 'react';

function agentBadge(agent: string | null): ReactElement {
  if (!agent) return <span className="px-1.5 py-0.5 rounded text-xs bg-slate-700 text-slate-300">—</span>;
  if (agent.startsWith('ai:'))
    return <span className="px-1.5 py-0.5 rounded text-xs bg-blue-500/20 text-blue-300">{agent}</span>;
  if (agent.startsWith('human'))
    return <span className="px-1.5 py-0.5 rounded text-xs bg-teal-500/20 text-teal-300">{agent}</span>;
  if (agent.startsWith('legacy:'))
    return <span className="px-1.5 py-0.5 rounded text-xs bg-slate-500/20 text-slate-400">{agent}</span>;
  if (agent.startsWith('system:'))
    return <span className="px-1.5 py-0.5 rounded text-xs bg-amber-500/20 text-amber-300">{agent}</span>;
  return <span className="px-1.5 py-0.5 rounded text-xs bg-slate-700 text-slate-300">{agent}</span>;
}

function confidenceBadge(conf: number | null): ReactElement {
  if (conf === null) return <span className="text-[var(--ff-text-tertiary)]">—</span>;
  const pct = Math.round(conf * 100);
  const color = pct >= 90 ? 'text-teal-400' : pct >= 70 ? 'text-amber-400' : 'text-red-400';
  return <span className={`font-mono text-xs ${color}`}>{pct}%</span>;
}

function JEDetailPanel({ jeId, onBack }: { jeId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<JEDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    setLoading(true);
    apiFetch(`/api/accounting/evidence/je/${jeId}`)
      .then(r => r.json())
      .then(json => { if (json.data) setDetail(json.data); else setErr('Not found'); })
      .catch(() => setErr('Failed to load JE detail'))
      .finally(() => setLoading(false));
  }, [jeId]);

  if (loading) return <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-indigo-400" /></div>;
  if (err) return <div className="flex items-center gap-2 text-red-400 py-4 text-sm"><AlertCircle className="h-4 w-4" />{err}</div>;

  const doc = detail?.document ?? null;
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] flex items-center gap-1">
        ← Back to evidence list
      </button>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-[var(--ff-bg-primary)] rounded-lg border border-[var(--ff-border-light)] p-4 space-y-2">
          <p className="text-xs font-semibold text-[var(--ff-text-tertiary)] uppercase tracking-wide">Source Document</p>
          {doc ? (
            <>
              {doc.thumbnail_url ? (
                <img src={doc.thumbnail_url} alt="Document thumbnail" className="w-full max-h-40 object-contain rounded border border-[var(--ff-border-light)]" />
              ) : (
                <div className="flex items-center justify-center w-full h-24 rounded border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <FileText className="h-8 w-8 text-[var(--ff-text-tertiary)]" />
                </div>
              )}
              {doc.vendor && <p className="text-sm text-[var(--ff-text-primary)]"><span className="text-[var(--ff-text-tertiary)]">Vendor: </span>{doc.vendor}</p>}
              {doc.reference && <p className="text-sm text-[var(--ff-text-primary)]"><span className="text-[var(--ff-text-tertiary)]">Ref: </span>{doc.reference}</p>}
              {doc.extraction_confidence !== null && doc.extraction_confidence !== undefined && (
                <p className="text-sm">Confidence: {confidenceBadge(doc.extraction_confidence)}</p>
              )}
            </>
          ) : (
            <p className="text-sm text-[var(--ff-text-tertiary)]">No source document attached</p>
          )}
        </div>
        <div className="bg-[var(--ff-bg-primary)] rounded-lg border border-[var(--ff-border-light)] p-4">
          <p className="text-xs font-semibold text-[var(--ff-text-tertiary)] uppercase tracking-wide mb-2">JE Lines</p>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {(detail?.lines ?? []).map((line, i) => (
              <div key={i} className="flex justify-between text-xs text-[var(--ff-text-secondary)]">
                <span className="font-mono">{String((line as Record<string, unknown>).account_code ?? '')}</span>
                <span>{fmt(Number((line as Record<string, unknown>).debit ?? 0))} / {fmt(Number((line as Record<string, unknown>).credit ?? 0))}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function EvidenceDrillModal({ accountId, accountName, periodStart, periodEnd, onClose }: Props) {
  const [rows, setRows] = useState<AccountEvidenceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [drillJeId, setDrillJeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    const params = new URLSearchParams({ from: periodStart, to: periodEnd, limit: '200' });
    apiFetch(`/api/accounting/evidence/trial-balance/${accountId}?${params}`)
      .then(r => r.json())
      .then(json => { setRows(json.data ?? []); })
      .catch(() => setErr('Failed to load evidence'))
      .finally(() => setLoading(false));
  }, [accountId, periodStart, periodEnd]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--ff-border-light)]">
          <div>
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Evidence for {accountName}</h2>
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">{periodStart} — {periodEnd}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]"><X className="h-5 w-5" /></button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-indigo-400" /></div>
          ) : err ? (
            <div className="flex items-center gap-2 text-red-400 text-sm"><AlertCircle className="h-4 w-4" />{err}</div>
          ) : drillJeId ? (
            <JEDetailPanel jeId={drillJeId} onBack={() => setDrillJeId(null)} />
          ) : rows.length === 0 ? (
            <div className="text-center py-12 text-[var(--ff-text-tertiary)]">No journal entries found for this period</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border-light)]">
                    <th className="pb-2 pr-3">Date</th>
                    <th className="pb-2 pr-3">JE#</th>
                    <th className="pb-2 pr-3">Description</th>
                    <th className="pb-2 pr-3 text-right">Debit</th>
                    <th className="pb-2 pr-3 text-right">Credit</th>
                    <th className="pb-2 pr-3">Agent</th>
                    <th className="pb-2 pr-3 text-right">Confidence</th>
                    <th className="pb-2">Evidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {rows.map(row => (
                    <tr key={row.je_id} className="hover:bg-[var(--ff-bg-primary)]/40">
                      <td className="py-2 pr-3 font-mono text-xs text-[var(--ff-text-secondary)] whitespace-nowrap">
                        {row.entry_date ? String(row.entry_date).substring(0, 10) : '—'}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs text-[var(--ff-text-tertiary)]">{row.entry_number ?? '—'}</td>
                      <td className="py-2 pr-3 text-[var(--ff-text-primary)] max-w-xs truncate">{row.description ?? '—'}</td>
                      <td className="py-2 pr-3 text-right font-mono text-xs text-[var(--ff-text-primary)]">{row.debit > 0 ? fmt(row.debit) : '—'}</td>
                      <td className="py-2 pr-3 text-right font-mono text-xs text-[var(--ff-text-primary)]">{row.credit > 0 ? fmt(row.credit) : '—'}</td>
                      <td className="py-2 pr-3">{agentBadge(row.posting_agent)}</td>
                      <td className="py-2 pr-3 text-right">{confidenceBadge(row.extraction_confidence)}</td>
                      <td className="py-2">
                        {row.source_document_id ? (
                          <button
                            onClick={() => setDrillJeId(row.je_id)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25"
                          >
                            <ExternalLink className="h-3 w-3" />
                            {row.document_vendor ?? row.document_reference ?? 'View'}
                          </button>
                        ) : (
                          <span className="text-[var(--ff-text-tertiary)] text-xs">—</span>
                        )}
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
  );
}
