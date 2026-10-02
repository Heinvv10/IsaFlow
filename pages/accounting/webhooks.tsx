/**
 * Webhooks Page — WS-8.1
 * Manage outbound webhook endpoints and view delivery logs.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { Webhook, Plus, Loader2, AlertCircle } from 'lucide-react';
import { WebhookForm, type WebhookFormState } from '@/components/accounting/webhooks/WebhookForm';
import { WebhookCard } from '@/components/accounting/webhooks/WebhookCard';
import type { Webhook as WebhookType, Delivery } from '@/modules/accounting/services/core/webhookService';

const BTN_PRIMARY = 'inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium';
const DEFAULT_FORM: WebhookFormState = { name: '', url: '', secret: '', events: [], isActive: true };

type TestResult = { success: boolean; status: number; body: string };

export default function WebhooksPage() {
  const { activeCompany } = useCompany();
  const [isMounted, setIsMounted] = useState(false);
  const [webhooks, setWebhooks] = useState<WebhookType[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<WebhookFormState>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, Delivery[]>>({});
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => { setIsMounted(true); }, []);

  const fetchWebhooks = useCallback(async (savedNotice?: string) => {
    if (!activeCompany) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/webhooks');
      await assertOk(res, 'Could not load the webhooks - try again');
      const json = await res.json() as { data: WebhookType[] };
      setWebhooks(json.data);
    } catch (err) {
      log.error('Failed to fetch webhooks', { error: err }, 'webhooks-page');
      setWebhooks([]);
      // After a good write, say so: the write is not undone by a failed refresh.
      setError(savedNotice ? `${savedNotice}, but the list could not be refreshed - reload the page` : apiErrorMessage(err, 'Could not load the webhooks - try again'));
    } finally {
      setLoading(false);
    }
  }, [activeCompany]);

  useEffect(() => { if (isMounted) void fetchWebhooks(); }, [isMounted, fetchWebhooks]);

  const fetchDeliveries = useCallback(async (webhookId: string) => {
    try {
      const res = await apiFetch(`/api/accounting/webhook-deliveries?webhook_id=${webhookId}&limit=20`);
      await assertOk(res, 'Could not load the delivery history - try again');
      const json = await res.json() as { data: Delivery[] };
      setDeliveries(prev => ({ ...prev, [webhookId]: json.data }));
    } catch (err) {
      log.error('Failed to fetch deliveries', { error: err }, 'webhooks-page');
      setError(apiErrorMessage(err, 'Could not load the delivery history - try again'));
    }
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId(prev => {
      const next = prev === id ? null : id;
      if (next) void fetchDeliveries(next);
      return next;
    });
  }, [fetchDeliveries]);

  const handleEdit = (wh: WebhookType) => {
    setEditId(wh.id);
    setForm({ name: wh.name, url: wh.url, secret: wh.secret || '', events: wh.events, isActive: wh.isActive });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name || !form.url || form.events.length === 0) {
      setError('Name, URL, and at least one event are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = { ...form, ...(editId ? { id: editId } : {}) };
      const res = await apiFetch('/api/accounting/webhooks', {
        method: editId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await assertOk(res, 'Could not save the webhook - try again');
      setShowForm(false);
      setEditId(null);
      setForm(DEFAULT_FORM);
      await fetchWebhooks(editId ? 'The webhook was saved' : 'The webhook was added');
    } catch (err) {
      log.error('Failed to save webhook', { error: err }, 'webhooks-page');
      setError(apiErrorMessage(err, 'Could not save the webhook - try again'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this webhook endpoint?')) return;
    try {
      const res = await apiFetch(`/api/accounting/webhooks?id=${id}`, { method: 'DELETE' });
      await assertOk(res, 'Could not delete the webhook - try again');
      await fetchWebhooks('The webhook was deleted');
    } catch (err) {
      log.error('Failed to delete webhook', { error: err }, 'webhooks-page');
      setError(apiErrorMessage(err, 'Could not delete the webhook - try again'));
    }
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const res = await apiFetch('/api/accounting/webhooks-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookId: id }),
      });
      await assertOk(res, 'Could not send the test webhook - try again');
      const json = await res.json() as { data: TestResult };
      setTestResults(prev => ({ ...prev, [id]: json.data }));
    } catch (err) {
      log.error('Failed to test webhook', { error: err }, 'webhooks-page');
      setError(apiErrorMessage(err, 'Could not send the test webhook - try again'));
    } finally {
      setTesting(null);
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
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Webhook className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Webhooks</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Send real-time events to external systems</p>
              </div>
            </div>
            <button onClick={() => { setShowForm(true); setEditId(null); setForm(DEFAULT_FORM); }} className={BTN_PRIMARY}>
              <Plus className="h-4 w-4" /> Add Webhook
            </button>
          </div>
        </div>

        <div className="px-6 py-6 space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
            </div>
          )}

          {showForm && (
            <WebhookForm
              form={form}
              isEdit={!!editId}
              saving={saving}
              onChange={updates => setForm(prev => ({ ...prev, ...updates }))}
              onSave={() => void handleSave()}
              onCancel={() => { setShowForm(false); setEditId(null); setForm(DEFAULT_FORM); }}
            />
          )}

          {loading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-teal-500" /></div>
          ) : webhooks.length === 0 && !error ? (
            <div className="text-center py-16 text-[var(--ff-text-secondary)]">
              <Webhook className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No webhooks configured</p>
              <p className="text-sm mt-1">Add a webhook to receive real-time event notifications.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {webhooks.map(wh => (
                <WebhookCard
                  key={wh.id}
                  webhook={wh}
                  deliveries={deliveries[wh.id]}
                  expanded={expandedId === wh.id}
                  testing={testing === wh.id}
                  testResult={testResults[wh.id]}
                  onToggle={() => toggleExpand(wh.id)}
                  onEdit={() => handleEdit(wh)}
                  onDelete={() => void handleDelete(wh.id)}
                  onTest={() => void handleTest(wh.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
