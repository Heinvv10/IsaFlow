/**
 * Dunning & Collections Page
 * Sage equivalent: Customers > Collections / Payment Reminders
 * Generate overdue payment reminders, track communication history
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AlertTriangle, Loader2, AlertCircle, Send, FileText, Clock, CheckCircle, Plus } from 'lucide-react';
import { log } from '@/lib/logger';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface OverdueClient {
  entityId: string;
  entityName: string;
  current: number;
  days30: number;
  days60: number;
  days90: number;
  days120Plus: number;
  total: number;
}

interface DunningComm {
  id: string;
  client_id: string;
  client_name: string;
  type: string;
  level: number;
  subject: string;
  total_overdue: number;
  status: string;
  sent_at: string | null;
  created_at: string;
  created_by_name: string | null;
}

const DUNNING_TEMPLATES = [
  { level: 1, subject: 'Friendly Payment Reminder', body: 'Dear {client},\n\nWe hope this message finds you well. This is a friendly reminder that your account has an outstanding balance of {amount}.\n\nPlease arrange payment at your earliest convenience. If you have already made payment, please disregard this notice.\n\nKind regards,\nVelocity Fibre Accounts' },
  { level: 2, subject: 'Second Payment Reminder — Account Overdue', body: 'Dear {client},\n\nDespite our previous reminder, your account remains overdue with an outstanding balance of {amount}.\n\nPlease arrange payment within 7 days to avoid further action. If there are any disputes or queries regarding your account, please contact us immediately.\n\nRegards,\nVelocity Fibre Accounts' },
  { level: 3, subject: 'Final Notice — Overdue Account', body: 'Dear {client},\n\nThis is a final notice regarding your overdue account with an outstanding balance of {amount}.\n\nIf payment is not received within 5 business days, we may be forced to suspend services and refer the matter for collection.\n\nPlease contact us immediately to discuss payment arrangements.\n\nRegards,\nVelocity Fibre Accounts' },
];

export default function DunningPage() {
  const [tab, setTab] = useState<'overdue' | 'history'>('overdue');
  const [overdue, setOverdue] = useState<OverdueClient[]>([]);
  const [history, setHistory] = useState<DunningComm[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCompose, setShowCompose] = useState<OverdueClient | null>(null);
  const [composeLevel, setComposeLevel] = useState(1);
  const [isSending, setIsSending] = useState(false);

  const loadOverdue = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/ar-aging');
      const json = await res.json();
      const data = json.data || json;
      const arr = Array.isArray(data) ? data : [];
      setOverdue(arr.filter((b: OverdueClient) => (b.days30 + b.days60 + b.days90 + b.days120Plus) > 0));
    } catch {
      setError('Failed to load overdue data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/accounting/dunning');
      const json = await res.json();
      setHistory(json.data || []);
    } catch {
      setError('Failed to load dunning history');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'overdue') loadOverdue();
    else loadHistory();
  }, [tab, loadOverdue, loadHistory]);

  async function handleCreateDunning(client: OverdueClient, level: number) {
    setIsSending(true);
    try {
      const template = DUNNING_TEMPLATES[level - 1] ?? DUNNING_TEMPLATES[0];
      if (!template) return;
      const body = template.body
        .replace('{client}', client.entityName)
        .replace('{amount}', formatCurrency(client.total));

      const res = await apiFetch('/api/accounting/dunning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: client.entityId,
          type: 'reminder',
          level,
          subject: template.subject,
          body,
          total_overdue: client.total,
          sent_via: 'email',
        }),
      });
      if (!res.ok) throw new Error('Failed to create dunning');
      setShowCompose(null);
      if (tab === 'history') loadHistory();
    } catch (err) {
      log.error('Dunning creation failed', { data: err }, 'Dunning');
      setError('Failed to create dunning communication');
    } finally {
      setIsSending(false);
    }
  }

  async function handleMarkSent(id: string) {
    try {
      await apiFetch('/api/accounting/dunning', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: 'sent', sent_at: new Date().toISOString() }),
      });
      loadHistory();
    } catch (err) {
      log.error('Mark sent failed', { data: err }, 'Dunning');
    }
  }

  const totalOverdue = overdue.reduce((sum, c) => sum + c.days30 + c.days60 + c.days90 + c.days120Plus, 0);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-500/10">
                <AlertTriangle className="h-6 w-6 text-red-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Dunning & Collections</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Overdue payment reminders and collection tracking
                </p>
              </div>
            </div>
          </div>
          <div className="px-6 flex gap-1">
            {(['overdue', 'history'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === t ? 'border-red-500 text-red-400' : 'border-transparent text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-secondary)]'
                }`}>
                {t === 'overdue' ? 'Overdue Clients' : 'Communication History'}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {/* Summary cards */}
          {tab === 'overdue' && !isLoading && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                <p className="text-xs text-[var(--ff-text-tertiary)]">Overdue Clients</p>
                <p className="text-xl font-bold text-red-400">{overdue.length}</p>
              </div>
              <div className="p-3 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                <p className="text-xs text-[var(--ff-text-tertiary)]">Total Overdue</p>
                <p className="text-xl font-bold text-red-400">{formatCurrency(totalOverdue)}</p>
              </div>
              <div className="p-3 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                <p className="text-xs text-[var(--ff-text-tertiary)]">60+ Days</p>
                <p className="text-xl font-bold text-orange-400">
                  {overdue.filter(c => (c.days60 + c.days90 + c.days120Plus) > 0).length}
                </p>
              </div>
              <div className="p-3 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                <p className="text-xs text-[var(--ff-text-tertiary)]">90+ Days</p>
                <p className="text-xl font-bold text-purple-400">
                  {overdue.filter(c => (c.days90 + c.days120Plus) > 0).length}
                </p>
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-red-500" />
            </div>
          ) : tab === 'overdue' ? (
            /* Overdue clients list */
            overdue.length === 0 ? (
              <div className="text-center py-12 text-[var(--ff-text-secondary)]">
                No overdue accounts — all current!
              </div>
            ) : (
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-light)]">
                      <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Client</th>
                      <th className="text-right px-4 py-3 text-amber-400 font-medium">1-30</th>
                      <th className="text-right px-4 py-3 text-orange-400 font-medium">31-60</th>
                      <th className="text-right px-4 py-3 text-red-400 font-medium">61-90</th>
                      <th className="text-right px-4 py-3 text-purple-400 font-medium">90+</th>
                      <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Total Due</th>
                      <th className="text-center px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overdue.map(c => (
                      <tr key={c.entityId} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)]">
                        <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{c.entityName}</td>
                        <td className="px-4 py-3 text-right font-mono text-amber-400">{formatCurrency(c.days30)}</td>
                        <td className="px-4 py-3 text-right font-mono text-orange-400">{formatCurrency(c.days60)}</td>
                        <td className="px-4 py-3 text-right font-mono text-red-400">{formatCurrency(c.days90)}</td>
                        <td className="px-4 py-3 text-right font-mono text-purple-400">{formatCurrency(c.days120Plus)}</td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-[var(--ff-text-primary)]">{formatCurrency(c.total)}</td>
                        <td className="px-4 py-3 text-center">
                          <button onClick={() => { setShowCompose(c); setComposeLevel(1); }}
                            className="inline-flex items-center gap-1 px-3 py-1 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-medium">
                            <Send className="h-3 w-3" /> Remind
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            /* Communication history */
            history.length === 0 ? (
              <div className="text-center py-12 text-[var(--ff-text-secondary)]">
                No dunning communications yet
              </div>
            ) : (
              <div className="space-y-3">
                {history.map(comm => (
                  <div key={comm.id} className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`p-1.5 rounded ${comm.status === 'sent' ? 'bg-teal-500/10' : 'bg-amber-500/10'}`}>
                          {comm.status === 'sent' ? <CheckCircle className="h-4 w-4 text-teal-400" /> : <Clock className="h-4 w-4 text-amber-400" />}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-[var(--ff-text-primary)]">{comm.subject}</p>
                          <p className="text-xs text-[var(--ff-text-tertiary)]">
                            {comm.client_name} • Level {comm.level} • {formatCurrency(comm.total_overdue)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-[var(--ff-text-tertiary)]">{formatDate(comm.created_at)}</span>
                        {comm.status === 'draft' && (
                          <button onClick={() => handleMarkSent(comm.id)}
                            className="inline-flex items-center gap-1 px-3 py-1 rounded bg-teal-500/10 hover:bg-teal-500/20 text-teal-400 text-xs font-medium">
                            <Send className="h-3 w-3" /> Mark Sent
                          </button>
                        )}
                        {comm.status === 'sent' && (
                          <span className="text-xs text-teal-400">Sent {comm.sent_at ? formatDate(comm.sent_at) : ''}</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        {/* Compose Modal */}
        {showCompose && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] max-w-lg w-full p-6 space-y-4">
              <h2 className="text-lg font-bold text-[var(--ff-text-primary)]">
                Send Payment Reminder
              </h2>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Client: <strong>{showCompose.entityName}</strong> — Overdue: <strong className="text-red-400">{formatCurrency(showCompose.total)}</strong>
              </p>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1">Reminder Level</label>
                <select value={composeLevel} onChange={e => setComposeLevel(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm">
                  <option value={1}>Level 1 — Friendly Reminder</option>
                  <option value={2}>Level 2 — Second Notice</option>
                  <option value={3}>Level 3 — Final Notice</option>
                </select>
              </div>

              <div className="p-3 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)]">
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Preview:</p>
                <p className="text-sm font-medium text-[var(--ff-text-primary)] mb-2">
                  {DUNNING_TEMPLATES[composeLevel - 1]?.subject}
                </p>
                <p className="text-xs text-[var(--ff-text-secondary)] whitespace-pre-line">
                  {(DUNNING_TEMPLATES[composeLevel - 1]?.body || '')
                    .replace('{client}', showCompose.entityName)
                    .replace('{amount}', formatCurrency(showCompose.total))}
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setShowCompose(null)}
                  className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
                  Cancel
                </button>
                <button
                  onClick={() => handleCreateDunning(showCompose, composeLevel)}
                  disabled={isSending}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium disabled:opacity-50"
                >
                  {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Create Reminder
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
