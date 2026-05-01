/**
 * State + handlers for the Bank Rules page. Wraps load/edit/submit/doAction
 * + bulk-delete + form state so the page itself stays under the 300-line
 * file budget. Keeps the side-effects (apiFetch calls) testable in isolation.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import type { BankRuleFormState } from './BankRuleForm';
import type { BankRuleRowData, VatCode } from './BankRuleRow';

export interface BankRule extends BankRuleRowData {
  glAccountId?: string;
  supplierId?: string;
  clientId?: string;
  descriptionTemplate?: string;
}

/**
 * Three-state result for the live preview of how many transactions a rule
 * would match. UI must distinguish "no preview yet" from "preview unavailable
 * because the endpoint failed", otherwise a broken endpoint manifests as a
 * permanent "Checking matches…" placeholder.
 */
export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; count: number }
  | { status: 'error' };

const BLANK_FORM: BankRuleFormState = {
  ruleName: '', matchField: 'description', matchType: 'contains',
  matchPattern: '', glAccountId: '', supplierId: '', clientId: '', vatCode: 'none',
  descriptionTemplate: '', priority: '100',
  autoCreateEntry: false,
};

export interface UseBankRulesResult {
  rules: BankRule[];
  filteredRules: BankRule[];
  loading: boolean;
  busy: string;
  error: string;
  applyResult: { applied: number; skipped: number; autoPostRulesSkippedNoBankGl?: number; autoPostSkippedClosedPeriod?: number } | null;
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  bulkDeleting: boolean;
  search: string;
  setSearch: (s: string) => void;
  showForm: boolean;
  setShowForm: React.Dispatch<React.SetStateAction<boolean>>;
  editingRule: BankRule | null;
  form: BankRuleFormState;
  setForm: React.Dispatch<React.SetStateAction<BankRuleFormState>>;
  previewState: PreviewState;
  selectedBankId: string;
  setSelectedBankId: (id: string) => void;
  resetForm: () => void;
  handleEdit: (rule: BankRule) => void;
  handleSubmit: (e: React.FormEvent<HTMLFormElement>) => Promise<void>;
  doAction: (action: string, id?: string, extra?: Record<string, unknown>) => Promise<void>;
  performBulkDelete: () => Promise<void>;
  load: () => Promise<void>;
}

interface UseBankRulesOptions {
  defaultBankId: string;
  /**
   * Returns:
   *   - a non-negative number on success
   *   - null when the endpoint failed (UI shows "preview unavailable", not
   *     a stuck loading indicator)
   */
  fetchPreview: (params: URLSearchParams) => Promise<number | null>;
}

export function useBankRules({ defaultBankId, fetchPreview }: UseBankRulesOptions): UseBankRulesResult {
  const [rules, setRules] = useState<BankRule[]>([]);
  const [selectedBankId, setSelectedBankId] = useState('');
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [applyResult, setApplyResult] = useState<
    { applied: number; skipped: number; autoPostRulesSkippedNoBankGl?: number; autoPostSkippedClosedPeriod?: number } | null
  >(null);
  const [editingRule, setEditingRule] = useState<BankRule | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [search, setSearch] = useState('');
  const [previewState, setPreviewState] = useState<PreviewState>({ status: 'idle' });
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [form, setForm] = useState<BankRuleFormState>(BLANK_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/bank-rules', { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as Record<string, unknown>));
        const msg = (body as { error?: { message?: string }; message?: string }).error?.message
          ?? (body as { message?: string }).message
          ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      const json = await res.json();
      setRules((json.data?.items as BankRule[]) || []);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Pick the first bank account once the ref-data hook resolves.
  useEffect(() => {
    if (defaultBankId && !selectedBankId) setSelectedBankId(defaultBankId);
  }, [defaultBankId, selectedBankId]);

  // Debounced live preview of match count for the form's current pattern.
  useEffect(() => {
    if (!form.matchPattern.trim() || !showForm) {
      setPreviewState({ status: 'idle' });
      return;
    }
    if (previewTimer.current) clearTimeout(previewTimer.current);
    setPreviewState({ status: 'loading' });
    previewTimer.current = setTimeout(async () => {
      const params = new URLSearchParams({
        pattern: form.matchPattern,
        matchType: form.matchType,
        matchField: form.matchField,
        ...(selectedBankId ? { bankAccountId: selectedBankId } : {}),
      });
      const result = await fetchPreview(params);
      // Three-state: number = ready, null = endpoint failed (error state).
      setPreviewState(result === null ? { status: 'error' } : { status: 'ready', count: result });
    }, 400);
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
  }, [form.matchPattern, form.matchType, form.matchField, showForm, selectedBankId, fetchPreview]);

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
    setForm(BLANK_FORM);
    setEditingRule(null);
    setShowForm(false);
    setPreviewState({ status: 'idle' });
  };

  const handleEdit = (rule: BankRule) => {
    setForm({
      ruleName: rule.ruleName,
      matchField: rule.matchField,
      matchType: rule.matchType,
      matchPattern: rule.matchPattern,
      glAccountId: rule.glAccountId || '',
      supplierId: rule.supplierId || '',
      clientId: rule.clientId || '',
      vatCode: rule.vatCode || ('none' as VatCode),
      descriptionTemplate: rule.descriptionTemplate || '',
      priority: String(rule.priority),
      autoCreateEntry: Boolean(rule.autoCreateEntry),
    });
    setEditingRule(rule);
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(''); setBusy('new');
    try {
      const payload = {
        ruleName: form.ruleName, matchField: form.matchField, matchType: form.matchType,
        matchPattern: form.matchPattern,
        glAccountId: form.glAccountId || undefined,
        supplierId: form.supplierId || undefined,
        clientId: form.clientId || undefined,
        descriptionTemplate: form.descriptionTemplate || undefined,
        priority: Number(form.priority) || 100,
        vatCode: form.vatCode || 'none',
        autoCreateEntry: form.autoCreateEntry,
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
          body: JSON.stringify({
            ...payload,
            ...(selectedBankId ? { bankAccountId: selectedBankId } : {}),
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.message || 'Failed to create rule');
        const applied = Number(json.data?.applied ?? 0);
        if (applied > 0) setApplyResult({ applied, skipped: 0 });
      }

      resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy('');
    }
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

  const performBulkDelete = async () => {
    if (selected.size === 0) return;
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

  return {
    rules, filteredRules, loading, busy, error, applyResult,
    selected, setSelected, bulkDeleting, search, setSearch,
    showForm, setShowForm, editingRule, form, setForm, previewState,
    selectedBankId, setSelectedBankId,
    resetForm, handleEdit, handleSubmit, doAction, performBulkDelete, load,
  };
}
