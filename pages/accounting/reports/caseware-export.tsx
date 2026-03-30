/**
 * CaseWare Export Page — WS-7.3
 * Map GL accounts to CaseWare codes and export trial balance CSV.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, Database, Loader2, AlertCircle, Download, Wand2, Save,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface AccountMapping {
  glAccountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  externalCode: string;
  externalLabel: string;
}

function getDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  return {
    periodStart: start.toISOString().split('T')[0] ?? '',
    periodEnd: now.toISOString().split('T')[0] ?? '',
  };
}

export default function CaseWareExportPage() {
  const defaults = getDefaultDates();
  const [periodStart, setPeriodStart] = useState(defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaults.periodEnd);

  const [mappings, setMappings] = useState<AccountMapping[]>([]);
  const [edits, setEdits] = useState<Record<string, { code: string; label: string }>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isAutoSuggesting, setIsAutoSuggesting] = useState(false);
  const [error, setError] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const [search, setSearch] = useState('');

  const loadMappings = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/account-mappings?system=caseware');
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Failed to load mappings');
      const items: AccountMapping[] = json.data?.items ?? [];
      setMappings(items);
      const initial: Record<string, { code: string; label: string }> = {};
      for (const m of items) {
        initial[m.glAccountId] = { code: m.externalCode, label: m.externalLabel };
      }
      setEdits(initial);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadMappings(); }, [loadMappings]);

  async function handleAutoSuggest() {
    setIsAutoSuggesting(true);
    setSaveMsg('');
    try {
      const res = await apiFetch('/api/accounting/account-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auto-suggest', targetSystem: 'caseware' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Auto-suggest failed');
      setSaveMsg(`Auto-suggested ${json.data?.applied ?? 0} account codes`);
      await loadMappings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auto-suggest failed');
    } finally {
      setIsAutoSuggesting(false);
    }
  }

  async function handleSaveAll() {
    setIsSaving(true);
    setSaveMsg('');
    setError('');
    try {
      const changes = Object.entries(edits).filter(([id, val]) => {
        const orig = mappings.find(m => m.glAccountId === id);
        return orig && (orig.externalCode !== val.code || orig.externalLabel !== val.label);
      });

      await Promise.all(
        changes.map(([glAccountId, val]) =>
          apiFetch('/api/accounting/account-mappings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              glAccountId,
              targetSystem: 'caseware',
              externalCode: val.code,
              externalLabel: val.label,
            }),
          }),
        ),
      );
      setSaveMsg(`Saved ${changes.length} mapping(s)`);
      await loadMappings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setIsSaving(false);
    }
  }

  function handleExport() {
    const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
    window.open(`/api/accounting/caseware-export?${params}`, '_blank');
  }

  function updateEdit(id: string, field: 'code' | 'label', value: string) {
    setEdits(prev => {
      const existing = prev[id] ?? { code: '', label: '' };
      return { ...prev, [id]: { ...existing, [field]: value } };
    });
  }

  const filtered = mappings.filter(m =>
    !search ||
    m.accountCode.toLowerCase().includes(search.toLowerCase()) ||
    m.accountName.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <Link href="/accounting/reports" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
              <ArrowLeft className="h-4 w-4" /> Back to Reports
            </Link>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-teal-500/10">
                  <Database className="h-6 w-6 text-teal-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">CaseWare Export</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">Map accounts and export trial balance for CaseWare</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-6xl space-y-6">
          {/* Export Controls */}
          <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-4">
            <h3 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-3">Export Trial Balance</h3>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Period From</label>
                <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)}
                  className="ff-input text-sm" />
              </div>
              <div>
                <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Period To</label>
                <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)}
                  className="ff-input text-sm" />
              </div>
              <button onClick={handleExport}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}
          {saveMsg && (
            <div className="p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">{saveMsg}</div>
          )}

          {/* Mapping Table */}
          <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--ff-border-light)] flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Account Mappings</h3>
              <div className="flex items-center gap-2">
                <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search accounts..." className="ff-input text-xs py-1 w-48" />
                <button onClick={() => void handleAutoSuggest()} disabled={isAutoSuggesting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded hover:text-[var(--ff-text-primary)] text-xs disabled:opacity-50">
                  {isAutoSuggesting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
                  Auto-Suggest
                </button>
                <button onClick={() => void handleSaveAll()} disabled={isSaving}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-teal-600 text-white rounded hover:bg-teal-700 text-xs disabled:opacity-50">
                  {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                  Save All
                </button>
              </div>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-[var(--ff-bg-tertiary)]">
                      <th className="text-left px-3 py-2 text-[var(--ff-text-secondary)] font-medium">Code</th>
                      <th className="text-left px-3 py-2 text-[var(--ff-text-secondary)] font-medium">Account Name</th>
                      <th className="text-left px-3 py-2 text-[var(--ff-text-secondary)] font-medium">Type</th>
                      <th className="text-left px-3 py-2 text-[var(--ff-text-secondary)] font-medium">CaseWare Code</th>
                      <th className="text-left px-3 py-2 text-[var(--ff-text-secondary)] font-medium">CaseWare Label</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ff-border-light)]">
                    {filtered.map((m, idx) => {
                      const edit = edits[m.glAccountId] ?? { code: m.externalCode, label: m.externalLabel };
                      const dirty = edit.code !== m.externalCode || edit.label !== m.externalLabel;
                      return (
                        <tr key={m.glAccountId} className={idx % 2 === 0 ? '' : 'bg-[var(--ff-bg-tertiary)]/30'}>
                          <td className="px-3 py-1.5 font-mono text-[var(--ff-text-secondary)]">{m.accountCode}</td>
                          <td className={`px-3 py-1.5 ${dirty ? 'text-amber-400' : 'text-[var(--ff-text-primary)]'}`}>
                            {m.accountName}
                          </td>
                          <td className="px-3 py-1.5 text-[var(--ff-text-tertiary)] capitalize">
                            {m.accountType}{m.accountSubtype ? ` / ${m.accountSubtype}` : ''}
                          </td>
                          <td className="px-3 py-1">
                            <input type="text" value={edit.code}
                              onChange={e => updateEdit(m.glAccountId, 'code', e.target.value)}
                              className="ff-input text-xs py-0.5 w-20 font-mono" maxLength={20} />
                          </td>
                          <td className="px-3 py-1">
                            <input type="text" value={edit.label}
                              onChange={e => updateEdit(m.glAccountId, 'label', e.target.value)}
                              className="ff-input text-xs py-0.5 w-48" maxLength={100} />
                          </td>
                        </tr>
                      );
                    })}
                    {filtered.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-8 text-center text-[var(--ff-text-secondary)]">
                          No accounts found
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Legend */}
          <div className="text-xs text-[var(--ff-text-tertiary)] space-y-1">
            <p className="font-medium text-[var(--ff-text-secondary)]">Common CaseWare codes:</p>
            <p>B10 Cash | B20 Trade receivables | B30 Inventories | B40 PPE | B90 Other assets</p>
            <p>C10 Trade payables | C20 Tax payable | C30 Borrowings | D10 Share capital | D20 Retained earnings</p>
            <p>E10 Revenue | F05 Cost of sales | F10 Operating expenses</p>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
