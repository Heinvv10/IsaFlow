/**
 * Recurring Transactions Page — WS-8.4
 * Manage recurring journal/invoice templates and execute them on demand.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { RefreshCw, Plus, Play, Trash2, Edit2, Loader2, AlertCircle, CheckCircle, XCircle, Calendar } from 'lucide-react';
import {
  RecurringModal, buildTemplateInput,
  type TemplateFormState, ENTITY_LABELS, FREQ_LABELS,
} from '@/components/accounting/recurring-transactions/RecurringModal';
import type { RecurringTemplate } from '@/modules/accounting/services/recurringTransactionService';

const BTN_PRIMARY = 'inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium';
const BTN_GHOST = 'inline-flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] rounded-lg hover:bg-[var(--ff-bg-primary)] transition-colors';

type ExecResult = { entityType: string; entityId: string; posted: boolean } | 'error';

const DEFAULT_FORM: TemplateFormState = {
  name: '', entityType: 'journal_entry', frequency: 'monthly',
  nextRunDate: new Date().toISOString().split('T')[0]!,
  isActive: true, autoPost: false, templateData: '{}',
};

export default function RecurringTransactionsPage() {
  const { activeCompany } = useCompany();
  const [isMounted, setIsMounted] = useState(false);
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateFormState>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [executing, setExecuting] = useState<string | null>(null);
  const [execResults, setExecResults] = useState<Record<string, ExecResult>>({});

  useEffect(() => { setIsMounted(true); }, []);

  const fetchTemplates = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/recurring-transactions');
      const json = await res.json() as { data: RecurringTemplate[] };
      setTemplates(json.data);
    } catch (err) {
      log.error('Failed to fetch recurring templates', { error: err }, 'recurring-page');
      setError('Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, [activeCompany]);

  useEffect(() => { if (isMounted) void fetchTemplates(); }, [isMounted, fetchTemplates]);

  const openCreate = () => { setEditId(null); setForm(DEFAULT_FORM); setFormError(null); setShowModal(true); };

  const openEdit = (t: RecurringTemplate) => {
    setEditId(t.id);
    setForm({
      name: t.name, entityType: t.entityType, frequency: t.frequency,
      nextRunDate: t.nextRunDate ?? new Date().toISOString().split('T')[0]!,
      isActive: t.isActive, autoPost: t.autoPost,
      templateData: JSON.stringify(t.templateData, null, 2),
    });
    setFormError(null);
    setShowModal(true);
  };

  const handleSave = async () => {
    setFormError(null);
    if (!form.name || !form.frequency || !form.entityType) {
      setFormError('Name, entity type, and frequency are required');
      return;
    }
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(form.templateData || '{}') as Record<string, unknown>; }
    catch { setFormError('Template Data must be valid JSON'); return; }
    void parsed;
    setSaving(true);
    try {
      const body = { ...buildTemplateInput(form), ...(editId ? { id: editId } : {}) };
      await apiFetch('/api/accounting/recurring-transactions', {
        method: editId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setShowModal(false);
      await fetchTemplates();
    } catch (err) {
      log.error('Failed to save recurring template', { error: err }, 'recurring-page');
      setFormError('Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this recurring template?')) return;
    try {
      await apiFetch(`/api/accounting/recurring-transactions?id=${id}`, { method: 'DELETE' });
      await fetchTemplates();
    } catch (err) {
      log.error('Failed to delete template', { error: err }, 'recurring-page');
    }
  };

  const handleRunNow = async (id: string) => {
    setExecuting(id);
    try {
      const res = await apiFetch('/api/accounting/recurring-transactions-execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: id }),
      });
      const json = await res.json() as { data: { entityType: string; entityId: string; posted: boolean } };
      setExecResults(prev => ({ ...prev, [id]: json.data }));
      await fetchTemplates();
    } catch (err) {
      log.error('Failed to execute recurring template', { error: err }, 'recurring-page');
      setExecResults(prev => ({ ...prev, [id]: 'error' }));
    } finally {
      setExecuting(null);
    }
  };

  if (!isMounted) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10"><RefreshCw className="h-6 w-6 text-teal-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Recurring Transactions</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Automate repeating journals, invoices, and more</p>
              </div>
            </div>
            <button onClick={openCreate} className={BTN_PRIMARY}><Plus className="h-4 w-4" /> New Template</button>
          </div>
        </div>

        <div className="px-6 py-6">
          {error && (
            <div className="flex items-center gap-2 p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
            </div>
          )}
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-teal-500" /></div>
          ) : templates.length === 0 ? (
            <div className="text-center py-16 text-[var(--ff-text-secondary)]">
              <Calendar className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No recurring templates</p>
              <p className="text-sm mt-1">Create a template to automate repeating transactions.</p>
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-[var(--ff-border-light)]">
                    <tr className="text-xs text-[var(--ff-text-secondary)]">
                      <th className="text-left px-5 py-3">Name</th>
                      <th className="text-left px-4 py-3">Type</th>
                      <th className="text-left px-4 py-3">Frequency</th>
                      <th className="text-left px-4 py-3">Next Run</th>
                      <th className="text-left px-4 py-3">Last Run</th>
                      <th className="text-left px-4 py-3">Status</th>
                      <th className="text-right px-5 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map(t => {
                      const res = execResults[t.id];
                      return (
                        <tr key={t.id} className="border-b border-[var(--ff-border-light)] last:border-0 hover:bg-[var(--ff-bg-primary)] transition-colors">
                          <td className="px-5 py-3 font-medium text-[var(--ff-text-primary)]">{t.name}</td>
                          <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{ENTITY_LABELS[t.entityType]}</td>
                          <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{FREQ_LABELS[t.frequency]}</td>
                          <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                            {t.nextRunDate ? new Date(t.nextRunDate).toLocaleDateString('en-ZA') : '—'}
                          </td>
                          <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                            {t.lastRunDate ? new Date(t.lastRunDate).toLocaleDateString('en-ZA') : '—'}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${t.isActive ? 'bg-green-500/15 text-green-400' : 'bg-gray-500/15 text-gray-400'}`}>
                              {t.isActive ? 'Active' : 'Paused'}
                            </span>
                            {t.autoPost && (
                              <span className="ml-1.5 text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-medium">Auto-post</span>
                            )}
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex items-center justify-end gap-2">
                              {res && res !== 'error' && (
                                <span className="flex items-center gap-1 text-xs text-green-400"><CheckCircle className="h-3.5 w-3.5" /> Created</span>
                              )}
                              {res === 'error' && (
                                <span className="flex items-center gap-1 text-xs text-red-400"><XCircle className="h-3.5 w-3.5" /> Failed</span>
                              )}
                              <button onClick={() => void handleRunNow(t.id)} disabled={executing === t.id || !t.isActive} className={BTN_GHOST}>
                                {executing === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                                Run Now
                              </button>
                              <button onClick={() => openEdit(t)} className={BTN_GHOST}><Edit2 className="h-3.5 w-3.5" /></button>
                              <button onClick={() => void handleDelete(t.id)} className="p-1.5 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors">
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {showModal && (
        <RecurringModal
          form={form}
          isEdit={!!editId}
          saving={saving}
          formError={formError}
          onChange={updates => setForm(prev => ({ ...prev, ...updates }))}
          onSave={() => void handleSave()}
          onClose={() => setShowModal(false)}
        />
      )}
    </AppLayout>
  );
}
