/**
 * Bank Categorisation Rules Page
 * Phase 2: Quick entry rules + statement mapping
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Zap, Plus, Trash2, Loader2, ToggleLeft, ToggleRight, Play, Pencil, Search, X } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

type VatCode = 'none' | 'standard' | 'zero_rated' | 'exempt';

const VAT_LABELS: Record<VatCode, string> = {
  none: 'No VAT',
  standard: '15%',
  zero_rated: 'Zero Rated',
  exempt: 'Exempt',
};

interface Rule {
  id: string;
  ruleName: string;
  matchField: string;
  matchType: string;
  matchPattern: string;
  glAccountId?: string;
  glAccountCode?: string;
  glAccountName?: string;
  supplierId?: string;
  supplierName?: string;
  clientId?: string;
  clientName?: string;
  descriptionTemplate?: string;
  priority: number;
  isActive: boolean;
  autoCreateEntry: boolean;
  vatCode: VatCode;
}

interface GLAccount { id: string; accountCode: string; accountName: string; defaultVatCode?: string }
interface Supplier { id: string; name: string }
interface Client { id: string; name: string }

export default function BankRulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [bankAccounts, setBankAccounts] = useState<GLAccount[]>([]);
  const [selectedBankId, setSelectedBankId] = useState('');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [applyResult, setApplyResult] = useState<{ applied: number; skipped: number } | null>(null);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [search, setSearch] = useState('');
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [form, setForm] = useState({
    ruleName: '', matchField: 'description', matchType: 'contains',
    matchPattern: '', glAccountId: '', supplierId: '', clientId: '', vatCode: '',
    descriptionTemplate: '', priority: '100',
  });

  const load = useCallback(async () => {
    const res = await apiFetch('/api/accounting/bank-rules', { credentials: 'include' });
    const json = await res.json();
    setRules(json.data?.items || []);
    setLoading(false);
    setSelected(new Set());
  }, []);

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} selected rule${selected.size > 1 ? 's' : ''}?`)) return;
    setBulkDeleting(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/bank-rules-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action: 'deleteMany', ids: [...selected] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Bulk delete failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk delete failed');
    } finally {
      setBulkDeleting(false);
    }
  };

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const mapAccount = (a: Record<string, unknown>) => ({
      id: String(a.id),
      accountCode: String(a.accountCode || a.account_code || ''),
      accountName: String(a.accountName || a.account_name || ''),
    });
    apiFetch('/api/accounting/chart-of-accounts', { credentials: 'include' }).then(r => r.json()).then(res => {
      const d = res.data || res;
      const list = Array.isArray(d) ? d : d.accounts || d.items || [];
      setAccounts(list.map((a: Record<string, unknown>) => ({
        ...mapAccount(a),
        defaultVatCode: String(a.defaultVatCode || a.default_vat_code || 'none'),
      })));
    });
    apiFetch('/api/accounting/bank-accounts', { credentials: 'include' }).then(r => r.json()).then(res => {
      const list = Array.isArray(res.data) ? res.data : [];
      const mapped = list.map((a: Record<string, unknown>) => ({
        id: String(a.id),
        accountCode: String(a.accountCode || ''),
        accountName: String(a.accountName || ''),
      }));
      setBankAccounts(mapped);
      if (mapped.length > 0) setSelectedBankId(String(mapped[0].id));
    });
    apiFetch('/api/suppliers?status=active', { credentials: 'include' }).then(r => r.json()).then(res => {
      const list = Array.isArray(res.data) ? res.data : [];
      setSuppliers(list.map((s: { id: number | string; name: string }) => ({
        id: String(s.id), name: s.name,
      })));
    });
    apiFetch('/api/clients', { credentials: 'include' }).then(r => r.json()).then(res => {
      const list = Array.isArray(res.data) ? res.data : [];
      setClients(list.map((c: { id: string; name?: string; company_name?: string; companyName?: string }) => ({
        id: c.id, name: c.company_name || c.companyName || c.name || '',
      })));
    });
  }, []);

  // Debounced live preview: fetch match count 400ms after pattern/matchType/matchField changes
  useEffect(() => {
    if (!form.matchPattern.trim() || !showForm) { setPreviewCount(null); return; }
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          pattern: form.matchPattern,
          matchType: form.matchType,
          matchField: form.matchField,
          ...(selectedBankId ? { bankAccountId: selectedBankId } : {}),
        });
        const res = await apiFetch(`/api/accounting/bank-rules-preview?${params}`, { credentials: 'include' });
        const json = await res.json();
        setPreviewCount(json.data?.matchCount ?? null);
      } catch { setPreviewCount(null); }
    }, 400);
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
  }, [form.matchPattern, form.matchType, form.matchField, showForm, selectedBankId]);

  // Client-side filter: name, pattern, GL account code/name
  const filteredRules = search.trim()
    ? rules.filter(r => {
        const q = search.toLowerCase();
        return r.ruleName.toLowerCase().includes(q)
          || r.matchPattern.toLowerCase().includes(q)
          || (r.glAccountCode || '').toLowerCase().includes(q)
          || (r.glAccountName || '').toLowerCase().includes(q)
          || (r.supplierName || '').toLowerCase().includes(q)
          || (r.clientName || '').toLowerCase().includes(q);
      })
    : rules;

  const resetForm = () => {
    setForm({ ruleName: '', matchField: 'description', matchType: 'contains', matchPattern: '', glAccountId: '', supplierId: '', clientId: '', vatCode: 'none', descriptionTemplate: '', priority: '100' });
    setEditingRule(null);
    setShowForm(false);
    setPreviewCount(null);
  };

  const handleEdit = (rule: Rule) => {
    setForm({
      ruleName: rule.ruleName,
      matchField: rule.matchField,
      matchType: rule.matchType,
      matchPattern: rule.matchPattern,
      glAccountId: rule.glAccountId || '',
      supplierId: rule.supplierId || '',
      clientId: rule.clientId || '',
      vatCode: rule.vatCode || 'none',
      descriptionTemplate: rule.descriptionTemplate || '',
      priority: String(rule.priority),
    });
    setEditingRule(rule);
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy('new');
    try {
      const payload = {
        ruleName: form.ruleName, matchField: form.matchField, matchType: form.matchType,
        matchPattern: form.matchPattern, glAccountId: form.glAccountId,
        supplierId: form.supplierId || undefined,
        clientId: form.clientId || undefined,
        descriptionTemplate: form.descriptionTemplate || undefined,
        priority: Number(form.priority) || 100,
        vatCode: form.vatCode || 'none',
      };

      if (editingRule) {
        const res = await apiFetch('/api/accounting/bank-rules-action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ action: 'update', id: editingRule.id, ...payload }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.message || 'Failed to update rule');
      } else {
        const res = await apiFetch('/api/accounting/bank-rules', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.message || 'Failed to create rule');
      }

      resetForm();
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setBusy(''); }
  };

  const doAction = async (action: string, id?: string, extra?: Record<string, unknown>) => {
    setBusy(id || action);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/bank-rules-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action, id, ...extra }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || `${action} failed`);
      if (action === 'apply' && json.data) setApplyResult(json.data);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusy('');
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/bank-reconciliation" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to Reconciliation
          </Link>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-yellow-500/10"><Zap className="h-6 w-6 text-yellow-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Categorisation Rules</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Auto-categorise bank transactions by pattern matching</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {bankAccounts.length > 1 && (
                <select
                  value={selectedBankId}
                  onChange={e => setSelectedBankId(e.target.value)}
                  className="ff-select text-sm py-2 px-3"
                >
                  {bankAccounts.map(a => (
                    <option key={a.id} value={a.id}>{a.accountCode} — {a.accountName}</option>
                  ))}
                </select>
              )}
              {selected.size > 0 && (
                <button
                  onClick={handleBulkDelete}
                  disabled={bulkDeleting}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium disabled:opacity-50"
                >
                  {bulkDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Delete {selected.size} selected
                </button>
              )}
              <button
                onClick={() => doAction('apply', undefined, { bankAccountId: selectedBankId })}
                disabled={!!busy || !selectedBankId}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50"
              >
                {busy === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Apply Rules
              </button>
              <button onClick={() => { resetForm(); setShowForm(v => !v); }} className="inline-flex items-center gap-2 px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 text-sm font-medium">
                <Plus className="h-4 w-4" /> New Rule
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
          {applyResult && (
            <div className="p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">
              Rules applied: {applyResult.applied} categorised, {applyResult.skipped} skipped
            </div>
          )}

          {showForm && (
            <form onSubmit={handleSubmit} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                {editingRule ? 'Edit Categorisation Rule' : 'New Categorisation Rule'}
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <input value={form.ruleName} onChange={e => setForm(f => ({ ...f, ruleName: e.target.value }))} className="ff-input" placeholder="Rule Name *" required />
                <select value={form.matchField} onChange={e => setForm(f => ({ ...f, matchField: e.target.value }))} className="ff-select">
                  <option value="description">Match Description</option>
                  <option value="reference">Match Reference</option>
                  <option value="both">Match Both</option>
                </select>
                <select value={form.matchType} onChange={e => setForm(f => ({ ...f, matchType: e.target.value }))} className="ff-select">
                  <option value="contains">Contains</option>
                  <option value="starts_with">Starts With</option>
                  <option value="ends_with">Ends With</option>
                  <option value="exact">Exact Match</option>
                </select>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <input value={form.matchPattern} onChange={e => setForm(f => ({ ...f, matchPattern: e.target.value }))} className="ff-input w-full" placeholder="Pattern (e.g. WOOLWORTHS) *" required />
                  {form.matchPattern.trim() && (
                    <p className="mt-1 text-xs text-[var(--ff-text-tertiary)]">
                      {previewCount === null ? 'Checking matches…' : (
                        <span className={previewCount > 0 ? 'text-teal-400' : 'text-[var(--ff-text-tertiary)]'}>
                          {previewCount} transaction{previewCount !== 1 ? 's' : ''} match
                        </span>
                      )}
                    </p>
                  )}
                </div>
                <select
                  value={form.glAccountId}
                  onChange={e => {
                    const acct = accounts.find(a => a.id === e.target.value);
                    setForm(f => ({
                      ...f,
                      glAccountId: e.target.value,
                      // Auto-fill VAT from account default when user picks an account
                      // (only if VAT hasn't been manually changed from 'none')
                      vatCode: acct?.defaultVatCode && f.vatCode === 'none'
                        ? acct.defaultVatCode as VatCode
                        : f.vatCode,
                    }));
                  }}
                  className="ff-select"
                  required={!form.supplierId && !form.clientId}
                >
                  <option value="">{form.supplierId || form.clientId ? 'No GL Account (optional)' : 'Select GL Account *'}</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.accountCode} — {a.accountName}</option>)}
                </select>
                <input type="number" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))} className="ff-input" placeholder="Priority (lower = first)" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <select value={form.supplierId} onChange={e => setForm(f => ({ ...f, supplierId: e.target.value, clientId: '' }))} className="ff-select">
                  <option value="">No Supplier (optional)</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <select value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value, supplierId: '' }))} className="ff-select">
                  <option value="">No Customer (optional)</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {/* Quick Win 3: VAT Code select */}
                <select value={form.vatCode} onChange={e => setForm(f => ({ ...f, vatCode: e.target.value }))} className="ff-select">
                  <option value="">No VAT</option>
                  <option value="standard">Standard 15%</option>
                  <option value="zero_rated">Zero Rated</option>
                  <option value="exempt">Exempt</option>
                </select>
                <input value={form.descriptionTemplate} onChange={e => setForm(f => ({ ...f, descriptionTemplate: e.target.value }))} className="ff-input" placeholder="Description template (optional)" />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={resetForm} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
                <button type="submit" disabled={busy === 'new'} className="px-6 py-2 bg-yellow-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {busy === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : (editingRule ? 'Save Changes' : 'Create Rule')}
                </button>
              </div>
            </form>
          )}

          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search rules by name, pattern, account…"
              className="ff-input w-full pl-9 pr-8"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {search && (
            <p className="text-xs text-[var(--ff-text-tertiary)] -mt-2">
              {filteredRules.length} of {rules.length} rules
            </p>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-3 py-3 w-8">
                  <input
                    type="checkbox"
                    checked={filteredRules.length > 0 && filteredRules.every(r => selected.has(r.id))}
                    ref={el => { if (el) { const some = filteredRules.some(r => selected.has(r.id)); el.indeterminate = some && !filteredRules.every(r => selected.has(r.id)); } }}
                    onChange={e => setSelected(prev => {
                      const next = new Set(prev);
                      filteredRules.forEach(r => e.target.checked ? next.add(r.id) : next.delete(r.id));
                      return next;
                    })}
                    className="rounded border-[var(--ff-border-light)] accent-yellow-500"
                  />
                </th>
                <th className="px-4 py-3">Rule</th>
                <th className="px-4 py-3">Match</th>
                <th className="px-4 py-3">Pattern</th>
                <th className="px-4 py-3">GL Account</th>
                <th className="px-4 py-3">Supplier / Customer</th>
                <th className="px-4 py-3">VAT</th>
                <th className="px-4 py-3">Priority</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={10} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">Loading...</td></tr>}
                {!loading && rules.length === 0 && <tr><td colSpan={10} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No rules configured. Create one to auto-categorise bank transactions.</td></tr>}
                {!loading && rules.length > 0 && filteredRules.length === 0 && <tr><td colSpan={10} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No rules match &ldquo;{search}&rdquo;</td></tr>}
                {filteredRules.map(rule => (
                  <tr key={rule.id} className={`border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50 ${selected.has(rule.id) ? 'bg-yellow-500/5' : ''}`}>
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(rule.id)}
                        onChange={e => setSelected(prev => {
                          const next = new Set(prev);
                          e.target.checked ? next.add(rule.id) : next.delete(rule.id);
                          return next;
                        })}
                        className="rounded border-[var(--ff-border-light)] accent-yellow-500"
                      />
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{rule.ruleName}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                      <span className="text-xs">{rule.matchField} {rule.matchType}</span>
                    </td>
                    <td className="px-4 py-3"><code className="px-2 py-0.5 rounded bg-[var(--ff-bg-primary)] text-yellow-400 text-xs">{rule.matchPattern}</code></td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] text-xs">
                      {rule.glAccountCode
                        ? `${rule.glAccountCode} — ${rule.glAccountName}`
                        : <span className="text-[var(--ff-text-tertiary)]">—</span>}
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] text-xs">
                      {rule.supplierName
                        ? <span><span className="text-blue-400 text-[10px] mr-1">SUP</span>{rule.supplierName}</span>
                        : rule.clientName
                        ? <span><span className="text-purple-400 text-[10px] mr-1">CUST</span>{rule.clientName}</span>
                        : <span className="text-[var(--ff-text-tertiary)]">{'\u2014'}</span>}
                    </td>
                    <td className="px-4 py-3">
                      {rule.vatCode && rule.vatCode !== 'none'
                        ? <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-400">{VAT_LABELS[rule.vatCode]}</span>
                        : <span className="text-[var(--ff-text-tertiary)] text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{rule.priority}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${rule.isActive ? 'bg-teal-500/10 text-teal-400' : 'bg-gray-500/10 text-gray-400'}`}>
                        {rule.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => handleEdit(rule)} disabled={!!busy} className="p-1 text-[var(--ff-text-secondary)] hover:text-yellow-400" title="Edit">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button onClick={() => doAction('toggle', rule.id, { isActive: !rule.isActive })} disabled={busy === rule.id} className="p-1 text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]" title={rule.isActive ? 'Disable' : 'Enable'}>
                          {rule.isActive ? <ToggleRight className="h-4 w-4 text-teal-400" /> : <ToggleLeft className="h-4 w-4" />}
                        </button>
                        <button onClick={() => doAction('delete', rule.id)} disabled={busy === rule.id} className="p-1 text-red-400 hover:text-red-300" title="Delete">
                          {busy === rule.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
