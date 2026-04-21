// pages/accounting/afs/mapping.tsx
// AFS Account Mapping — map GL accounts to BS/IS disclosure codes

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/ui';
import { apiFetch } from '@/lib/apiFetch';
import {
  GitMerge, Loader2, AlertCircle, CheckCircle, Wand2, ChevronDown, ChevronRight,
  ArrowRight, Search, X, BarChart3,
} from 'lucide-react';

// ── Types ───────────────────────────────────────────────────────────────────

interface StatementLine {
  id: string;
  code: string;
  section: 'balance_sheet' | 'income_statement';
  label: string;
  parentCode: string | null;
  noteNumber: number | null;
  sortOrder: number;
  combineGroup: string | null;
  isHeader: boolean;
  isTotal: boolean;
  isActive: boolean;
}

interface MappedAccount {
  id: string;
  glAccountId: string;
  afsLineCode: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
}

interface UnmappedAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
}

interface MappingStats {
  totalAccounts: number;
  mappedAccounts: number;
  unmappedAccounts: number;
  totalLines: number;
  activeLines: number;
  linesWithMappings: number;
}

interface AutoMapResult {
  mapped: number;
  skipped: number;
  suggestions: Array<{
    glAccountId: string;
    accountCode: string;
    accountName: string;
    suggestedCode: string;
    suggestedLabel: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
}

// ── Component ───────────────────────────────────────────────────────────────

export default function AfsMappingPage() {
  const [lines, setLines] = useState<StatementLine[]>([]);
  const [mappings, setMappings] = useState<MappedAccount[]>([]);
  const [unmapped, setUnmapped] = useState<UnmappedAccount[]>([]);
  const [stats, setStats] = useState<MappingStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isSeeding, setIsSeeding] = useState(false);
  const [isAutoMapping, setIsAutoMapping] = useState(false);
  const [autoMapResult, setAutoMapResult] = useState<AutoMapResult | null>(null);
  const [activeTab, setActiveTab] = useState<'balance_sheet' | 'income_statement'>('balance_sheet');
  const [expandedCodes, setExpandedCodes] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [assigningAccountId, setAssigningAccountId] = useState<string | null>(null);

  // ── Data Loading ────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const [linesRes, mappingsRes, unmappedRes, statsRes] = await Promise.all([
        apiFetch('/api/accounting/afs-mapping/lines', { credentials: 'include' }),
        apiFetch('/api/accounting/afs-mapping/accounts', { credentials: 'include' }),
        apiFetch('/api/accounting/afs-mapping/accounts?unmapped=true', { credentials: 'include' }),
        apiFetch('/api/accounting/afs-mapping/stats', { credentials: 'include' }),
      ]);
      const [linesJson, mappingsJson, unmappedJson, statsJson] = await Promise.all([
        linesRes.json(), mappingsRes.json(), unmappedRes.json(), statsRes.json(),
      ]);
      setLines(linesJson.data ?? []);
      setMappings(mappingsJson.data ?? []);
      setUnmapped(unmappedJson.data ?? []);
      setStats(statsJson.data ?? null);
    } catch {
      setError('Failed to load mapping data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  // ── Actions ─────────────────────────────────────────────────────────────

  async function handleSeedTaxonomy() {
    setIsSeeding(true);
    setError('');
    setSuccess('');
    try {
      const res = await apiFetch('/api/accounting/afs-mapping/lines', {
        method: 'POST', credentials: 'include',
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? 'Seed failed');
      setSuccess(`Taxonomy seeded: ${json.data?.created ?? 0} lines created, ${json.data?.existing ?? 0} already existed`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Seed failed');
    } finally {
      setIsSeeding(false);
    }
  }

  async function handleAutoMap() {
    setIsAutoMapping(true);
    setError('');
    setSuccess('');
    setAutoMapResult(null);
    try {
      const res = await apiFetch('/api/accounting/afs-mapping/auto-map', {
        method: 'POST', credentials: 'include',
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? 'Auto-map failed');
      setAutoMapResult(json.data);
      setSuccess(`Auto-mapped ${json.data?.mapped ?? 0} accounts. ${json.data?.suggestions?.length ?? 0} suggestions for review.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auto-map failed');
    } finally {
      setIsAutoMapping(false);
    }
  }

  async function handleMapAccount(glAccountId: string, afsLineCode: string) {
    setError('');
    try {
      const res = await apiFetch('/api/accounting/afs-mapping/accounts', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ glAccountId, afsLineCode }),
      });
      if (!res.ok) throw new Error('Map failed');
      setAssigningAccountId(null);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Map failed');
    }
  }

  async function handleUnmapAccount(glAccountId: string) {
    setError('');
    try {
      const res = await apiFetch('/api/accounting/afs-mapping/accounts', {
        method: 'DELETE', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ glAccountId }),
      });
      if (!res.ok) throw new Error('Unmap failed');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unmap failed');
    }
  }

  async function handleAcceptSuggestion(glAccountId: string, afsLineCode: string) {
    await handleMapAccount(glAccountId, afsLineCode);
    setAutoMapResult((prev) => prev ? {
      ...prev,
      suggestions: prev.suggestions.filter((s) => s.glAccountId !== glAccountId),
    } : null);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  const filteredLines = lines
    .filter((l) => l.section === activeTab)
    .filter((l) => !searchTerm || l.label.toLowerCase().includes(searchTerm.toLowerCase()) || l.code.toLowerCase().includes(searchTerm.toLowerCase()));

  function getMappingsForCode(code: string) {
    return mappings.filter((m) => m.afsLineCode === code);
  }

  function toggleExpand(code: string) {
    setExpandedCodes((prev) => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  }

  const coveragePct = stats ? Math.round((stats.mappedAccounts / Math.max(stats.totalAccounts, 1)) * 100) : 0;

  // ── Render ──────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
        <PageHeader
          icon={GitMerge}
          title="AFS Account Mapping"
          subtitle="Map GL accounts to standardised BS/IS disclosure codes"
          actions={
            <div className="flex items-center gap-2">
              {lines.length === 0 && (
                <button
                  onClick={() => { void handleSeedTaxonomy(); }}
                  disabled={isSeeding}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium disabled:opacity-50 transition-colors"
                >
                  {isSeeding ? <Loader2 className="w-4 h-4 animate-spin" /> : <BarChart3 className="w-4 h-4" />}
                  Seed Default Taxonomy
                </button>
              )}
              {lines.length > 0 && (
                <button
                  onClick={() => { void handleAutoMap(); }}
                  disabled={isAutoMapping}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-50 transition-colors"
                >
                  {isAutoMapping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                  Auto-Map Accounts
                </button>
              )}
            </div>
          }
        />

        {/* Messages */}
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">
            <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
          </div>
        )}
        {success && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm dark:bg-green-900/20 dark:border-green-800 dark:text-green-400">
            <CheckCircle className="w-4 h-4 flex-shrink-0" /> {success}
          </div>
        )}

        {/* Stats Bar */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: 'GL Accounts', value: stats.totalAccounts },
              { label: 'Mapped', value: stats.mappedAccounts },
              { label: 'Unmapped', value: stats.unmappedAccounts },
              { label: 'AFS Lines', value: stats.activeLines },
              { label: 'Coverage', value: `${coveragePct}%` },
            ].map((s) => (
              <div key={s.label} className="bg-white dark:bg-slate-800 rounded-lg border border-zinc-200 dark:border-slate-700 px-4 py-3 text-center">
                <p className="text-lg font-semibold text-zinc-900 dark:text-white">{s.value}</p>
                <p className="text-xs text-zinc-500 dark:text-slate-400">{s.label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Auto-map Suggestions */}
        {autoMapResult && autoMapResult.suggestions.length > 0 && (
          <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-800 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              Suggestions for Review ({autoMapResult.suggestions.length})
            </h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {autoMapResult.suggestions.map((s) => (
                <div key={s.glAccountId} className="flex items-center justify-between gap-3 bg-white dark:bg-slate-800 rounded-lg px-3 py-2 text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-xs text-zinc-500">{s.accountCode}</span>
                    <span className="truncate text-zinc-700 dark:text-zinc-300">{s.accountName}</span>
                    <ArrowRight className="w-3 h-3 text-zinc-400 flex-shrink-0" />
                    <span className="font-mono text-xs text-indigo-600 dark:text-indigo-400">{s.suggestedCode}</span>
                    <span className="text-zinc-500 truncate">{s.suggestedLabel}</span>
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                      s.confidence === 'medium'
                        ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                        : 'bg-zinc-100 text-zinc-500 dark:bg-slate-700 dark:text-slate-400'
                    }`}>
                      {s.confidence}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => { void handleAcceptSuggestion(s.glAccountId, s.suggestedCode); }}
                      className="px-2 py-1 rounded bg-green-600 hover:bg-green-700 text-white text-xs"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => setAutoMapResult((prev) => prev ? {
                        ...prev,
                        suggestions: prev.suggestions.filter((x) => x.glAccountId !== s.glAccountId),
                      } : null)}
                      className="px-2 py-1 rounded bg-zinc-200 hover:bg-zinc-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-zinc-600 dark:text-zinc-300 text-xs"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {lines.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <GitMerge className="w-10 h-10 text-zinc-700 dark:text-zinc-300 mb-3" />
            <p className="text-zinc-500 text-sm">No taxonomy loaded. Click &quot;Seed Default Taxonomy&quot; to start.</p>
          </div>
        )}

        {lines.length > 0 && (
          <>
            {/* Tabs + Search */}
            <div className="flex items-center justify-between gap-4">
              <div className="flex gap-1 bg-zinc-100 dark:bg-slate-800 rounded-lg p-1">
                {(['balance_sheet', 'income_statement'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                      activeTab === tab
                        ? 'bg-white dark:bg-slate-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-500 dark:text-slate-400 hover:text-zinc-700 dark:hover:text-zinc-300'
                    }`}
                  >
                    {tab === 'balance_sheet' ? 'Balance Sheet' : 'Income Statement'}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  placeholder="Search lines..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9 pr-8 py-2 rounded-lg border border-zinc-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-zinc-900 dark:text-white w-64 focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
                {searchTerm && (
                  <button onClick={() => setSearchTerm('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Mapping Tree */}
            <div className="rounded-xl border border-zinc-200 dark:border-slate-700 overflow-hidden divide-y divide-zinc-100 dark:divide-slate-800">
              {filteredLines.map((line) => {
                const lineMappings = getMappingsForCode(line.code);
                const isExpanded = expandedCodes.has(line.code);
                const hasData = lineMappings.length > 0;

                return (
                  <div key={line.code}>
                    {/* Line row */}
                    <div
                      className={`flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-zinc-50 dark:hover:bg-slate-800/50 transition-colors ${
                        line.isHeader ? 'bg-zinc-50 dark:bg-slate-800/30' : ''
                      } ${line.isTotal ? 'bg-zinc-50 dark:bg-slate-800/30 font-semibold' : ''}`}
                      onClick={() => { if (!line.isHeader && !line.isTotal) toggleExpand(line.code); }}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {!line.isHeader && !line.isTotal ? (
                          isExpanded ? <ChevronDown className="w-4 h-4 text-zinc-400 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-zinc-400 flex-shrink-0" />
                        ) : (
                          <div className="w-4" />
                        )}
                        <span className="font-mono text-xs text-zinc-500 dark:text-slate-500 w-12 flex-shrink-0">{line.code}</span>
                        <span className={`text-sm truncate ${
                          line.isHeader || line.isTotal ? 'font-semibold text-zinc-900 dark:text-white' : 'text-zinc-700 dark:text-zinc-300'
                        }`}>
                          {line.label}
                        </span>
                        {line.noteNumber && (
                          <span className="px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-xs flex-shrink-0">
                            Note {line.noteNumber}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {hasData && (
                          <span className="px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-medium">
                            {lineMappings.length} account{lineMappings.length !== 1 ? 's' : ''}
                          </span>
                        )}
                        {!line.isHeader && !line.isTotal && !hasData && (
                          <span className="px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-slate-700 text-zinc-400 dark:text-slate-500 text-xs">
                            unmapped
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Expanded detail */}
                    {isExpanded && !line.isHeader && !line.isTotal && (
                      <div className="bg-zinc-50/50 dark:bg-slate-900/30 px-4 py-3 space-y-2 border-t border-zinc-100 dark:border-slate-800">
                        {/* Mapped accounts */}
                        {lineMappings.map((m) => (
                          <div key={m.glAccountId} className="flex items-center justify-between gap-3 bg-white dark:bg-slate-800 rounded-lg px-3 py-2 text-sm">
                            <div className="flex items-center gap-2 min-w-0">
                              <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                              <span className="font-mono text-xs text-zinc-500">{m.accountCode}</span>
                              <span className="truncate text-zinc-700 dark:text-zinc-300">{m.accountName}</span>
                              <span className="text-xs text-zinc-400">({m.accountType})</span>
                            </div>
                            <button
                              onClick={() => { void handleUnmapAccount(m.glAccountId); }}
                              className="text-xs text-red-500 hover:text-red-700 flex-shrink-0"
                            >
                              Remove
                            </button>
                          </div>
                        ))}

                        {/* Assign button / dropdown */}
                        {assigningAccountId !== line.code ? (
                          <button
                            onClick={() => setAssigningAccountId(line.code)}
                            className="flex items-center gap-1 text-xs text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300"
                          >
                            <ArrowRight className="w-3 h-3" /> Assign GL account
                          </button>
                        ) : (
                          <div className="space-y-1">
                            <p className="text-xs text-zinc-500">Select an unmapped account:</p>
                            <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-200 dark:border-slate-700 divide-y divide-zinc-100 dark:divide-slate-800">
                              {unmapped.length === 0 && (
                                <p className="px-3 py-2 text-xs text-zinc-400">All accounts are mapped</p>
                              )}
                              {unmapped.map((acct) => (
                                <button
                                  key={acct.id}
                                  onClick={() => { void handleMapAccount(acct.id, line.code); }}
                                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-colors"
                                >
                                  <span className="font-mono text-xs text-zinc-500">{acct.accountCode}</span>
                                  <span className="truncate text-zinc-700 dark:text-zinc-300">{acct.accountName}</span>
                                  <span className="text-xs text-zinc-400 ml-auto flex-shrink-0">({acct.accountType})</span>
                                </button>
                              ))}
                            </div>
                            <button
                              onClick={() => setAssigningAccountId(null)}
                              className="text-xs text-zinc-400 hover:text-zinc-600"
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
