/**
 * Rate Curve Admin
 * Lists curves, lets you create new ones and bulk-upsert rate points via CSV.
 * Route: /accounting/loans/rate-curves
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, Plus, ChevronDown, ChevronRight, Upload } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { RateCurve, RatePoint } from '@/components/loans/types';
import { fmtDate } from '@/components/loans/types';

export default function RateCurvesPage() {
  const [curves, setCurves] = useState<RateCurve[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [points, setPoints] = useState<Record<string, RatePoint[]>>({});
  const [pointsLoading, setPointsLoading] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<Record<string, string>>({});

  const loadCurves = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/loan-rate-curves', { credentials: 'include' });
      const json = await res.json();
      setCurves(json.data || []);
    } catch { setCurves([]); }
    setLoading(false);
  }, []);

  useEffect(() => { loadCurves(); }, [loadCurves]);

  const loadPoints = async (curveId: string) => {
    if (points[curveId]) return;
    setPointsLoading(curveId);
    try {
      const res = await apiFetch(`/api/accounting/loan-rate-curves/${curveId}/points`, { credentials: 'include' });
      const json = await res.json();
      setPoints(prev => ({ ...prev, [curveId]: json.data || [] }));
    } catch { /* ignore */ }
    setPointsLoading(null);
  };

  const toggleExpand = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    await loadPoints(id);
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await apiFetch('/api/accounting/loan-rate-curves', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (res.ok) {
        setNewName('');
        setShowNewForm(false);
        await loadCurves();
      }
    } finally { setCreating(false); }
  };

  const handleCsvUpload = async (curveId: string, file: File) => {
    setUploadStatus(prev => ({ ...prev, [curveId]: 'Parsing…' }));
    const text = await file.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const pts: { effectiveDate: string; rate: number }[] = [];
    for (const line of lines) {
      if (line.startsWith('effective_date') || line.startsWith('date')) continue;
      const [d, r] = line.split(',');
      if (d && r && !isNaN(parseFloat(r))) {
        pts.push({ effectiveDate: d.trim(), rate: parseFloat(r.trim()) });
      }
    }
    if (pts.length === 0) {
      setUploadStatus(prev => ({ ...prev, [curveId]: 'No valid rows found' }));
      return;
    }
    setUploadStatus(prev => ({ ...prev, [curveId]: `Uploading ${pts.length} points…` }));
    try {
      const res = await apiFetch(`/api/accounting/loan-rate-curves/${curveId}/points`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: pts }),
      });
      if (res.ok) {
        setUploadStatus(prev => ({ ...prev, [curveId]: `✓ ${pts.length} points uploaded` }));
        setPoints(prev => ({ ...prev, [curveId]: undefined as unknown as RatePoint[] }));
        await loadPoints(curveId);
      } else {
        setUploadStatus(prev => ({ ...prev, [curveId]: 'Upload failed' }));
      }
    } catch {
      setUploadStatus(prev => ({ ...prev, [curveId]: 'Upload error' }));
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Rate Curves</h1>
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">Manage prime rate and custom interest rate curves</p>
            </div>
            <button
              onClick={() => setShowNewForm(v => !v)}
              className="flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Curve
            </button>
          </div>

          {showNewForm && (
            <div className="mt-4 flex items-center gap-3">
              <input
                type="text"
                placeholder="Curve name (e.g. SA Prime)"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-500 w-72"
                autoFocus
              />
              <button
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50 transition-colors"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
              </button>
              <button onClick={() => setShowNewForm(false)} className="text-sm text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">Cancel</button>
            </div>
          )}
        </div>

        <div className="p-6 space-y-3">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
            </div>
          )}

          {!loading && curves.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-[var(--ff-text-tertiary)]">
              <p className="text-sm">No rate curves yet. Create one to get started.</p>
            </div>
          )}

          {curves.map(curve => (
            <div key={curve.id} className="rounded-xl border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] overflow-hidden">
              <button
                onClick={() => toggleExpand(curve.id)}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-[var(--ff-bg-primary)] transition-colors"
              >
                <div className="flex items-center gap-3">
                  {expandedId === curve.id
                    ? <ChevronDown className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                    : <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                  }
                  <span className="font-medium text-[var(--ff-text-primary)]">{curve.name}</span>
                  {curve.pointCount != null && (
                    <span className="text-xs text-[var(--ff-text-tertiary)] bg-[var(--ff-bg-primary)] px-2 py-0.5 rounded-full">
                      {curve.pointCount} points
                    </span>
                  )}
                </div>
              </button>

              {expandedId === curve.id && (
                <div className="border-t border-[var(--ff-border-light)] p-5 space-y-4">
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 cursor-pointer rounded-lg border border-dashed border-[var(--ff-border-light)] px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:border-teal-500 hover:text-teal-400 transition-colors">
                      <Upload className="h-4 w-4" />
                      Upload CSV
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        className="hidden"
                        onChange={e => {
                          const f = e.target.files?.[0];
                          if (f) handleCsvUpload(curve.id, f);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    {uploadStatus[curve.id] && (
                      <span className="text-xs text-[var(--ff-text-tertiary)]">{uploadStatus[curve.id]}</span>
                    )}
                    <span className="text-xs text-[var(--ff-text-tertiary)]">CSV format: effective_date,rate (one per line)</span>
                  </div>

                  {pointsLoading === curve.id && (
                    <div className="flex items-center gap-2 text-sm text-[var(--ff-text-tertiary)]">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading points…
                    </div>
                  )}

                  {!pointsLoading && points[curve.id] && (
                    <div className="overflow-auto max-h-80">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border-light)]">
                            <th className="pb-2 font-medium">Effective Date</th>
                            <th className="pb-2 font-medium text-right">Rate (%)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--ff-border-light)]">
                          {(points[curve.id] ?? []).map((pt, i) => (
                            <tr key={i} className="hover:bg-[var(--ff-bg-primary)]">
                              <td className="py-2 text-[var(--ff-text-primary)]">{fmtDate(pt.effectiveDate)}</td>
                              <td className="py-2 text-right font-mono text-[var(--ff-text-primary)]">{Number(pt.rate).toFixed(4)}</td>
                            </tr>
                          ))}
                          {(points[curve.id] ?? []).length === 0 && (
                            <tr><td colSpan={2} className="py-4 text-center text-[var(--ff-text-tertiary)] text-xs">No rate points yet. Upload a CSV to add.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
