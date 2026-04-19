// Practice Client Detail Page — /accounting/practice/clients/[id]
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Users, Loader2, AlertCircle, ArrowLeft, User, Phone, Mail } from 'lucide-react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';
import { ClientRateOverrides } from '@/components/practice/ClientRateOverrides';

type ClientStatus = 'prospect' | 'onboarding' | 'active' | 'inactive' | 'archived';
type BillingModel = 'hourly' | 'fixed' | 'retainer';
type ActiveTab = 'details' | 'contacts' | 'rate-overrides';

interface PracticeClient {
  id: string;
  legalName: string;
  tradingName: string | null;
  registrationNo: string | null;
  taxNo: string | null;
  billingModel: BillingModel;
  status: ClientStatus;
  clientGroupId: string | null;
}

interface ClientContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  isPrimary: boolean;
}

const STATUS_COLOURS: Record<ClientStatus, string> = {
  prospect: 'bg-blue-500/20 text-blue-400',
  onboarding: 'bg-yellow-500/20 text-yellow-400',
  active: 'bg-teal-500/20 text-teal-400',
  inactive: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]',
  archived: 'bg-red-500/20 text-red-400',
};

const STATUS_LABELS: Record<ClientStatus, string> = {
  prospect: 'Prospect',
  onboarding: 'Onboarding',
  active: 'Active',
  inactive: 'Inactive',
  archived: 'Archived',
};

const BILLING_LABELS: Record<BillingModel, string> = {
  hourly: 'Hourly',
  fixed: 'Fixed',
  retainer: 'Retainer',
};

const TABS: { id: ActiveTab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'rate-overrides', label: 'Rate Overrides' },
];

function StatusBadge({ status }: { status: ClientStatus }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-3 border-b border-[var(--ff-border-primary)] last:border-0">
      <dt className="w-40 shrink-0 text-sm text-[var(--ff-text-secondary)]">{label}</dt>
      <dd className="text-sm text-[var(--ff-text-primary)]">{value}</dd>
    </div>
  );
}

export default function PracticeClientDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const clientId = typeof id === 'string' ? id : null;

  const [client, setClient] = useState<PracticeClient | null>(null);
  const [contacts, setContacts] = useState<ClientContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('details');

  const loadData = useCallback(async () => {
    if (!clientId) return;
    setLoading(true);
    setError('');
    try {
      const [clientRes, contactsRes] = await Promise.all([
        apiFetch(`/api/accounting/practice/clients/${clientId}`),
        apiFetch(`/api/accounting/practice/client-contacts?clientId=${clientId}`),
      ]);
      if (clientRes.status === 404) {
        setNotFound(true);
        return;
      }
      if (!clientRes.ok) throw new Error(`HTTP ${clientRes.status}`);
      const clientJson = await clientRes.json() as { data?: PracticeClient } | PracticeClient;
      setClient(('data' in clientJson ? clientJson.data : clientJson) as PracticeClient);

      if (contactsRes.ok) {
        const contactsJson = await contactsRes.json() as { data?: ClientContact[] } | ClientContact[];
        setContacts(('data' in contactsJson ? contactsJson.data : contactsJson) as ClientContact[] ?? []);
      }
    } catch {
      setError('Failed to load client');
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  if (notFound) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-screen gap-4">
          <AlertCircle className="h-12 w-12 text-[var(--ff-text-tertiary)]" />
          <p className="text-[var(--ff-text-secondary)] text-lg font-medium">Client not found</p>
          <Link
            href="/accounting/practice/clients"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Clients
          </Link>
        </div>
      </AppLayout>
    );
  }

  if (error || !client) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center gap-2 min-h-screen text-red-400">
          <AlertCircle className="h-5 w-5" />
          <span>{error || 'Failed to load client'}</span>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <nav className="flex items-center gap-1.5 text-xs text-[var(--ff-text-tertiary)] mb-3">
              <Link href="/accounting/practice/clients" className="hover:text-teal-400 transition-colors">
                Clients
              </Link>
              <span>/</span>
              <span className="text-[var(--ff-text-secondary)]">{client.legalName}</span>
            </nav>

            <div className="flex items-center gap-4">
              <Link
                href="/accounting/practice/clients"
                className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Users className="h-5 w-5 text-teal-400" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">{client.legalName}</h1>
                  <StatusBadge status={client.status} />
                </div>
                {client.tradingName && (
                  <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">{client.tradingName}</p>
                )}
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 mt-4">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? 'bg-teal-500/10 text-teal-400'
                      : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]'
                  }`}
                >
                  {tab.label}
                  {tab.id === 'contacts' && contacts.length > 0 && (
                    <span className="ml-1.5 text-xs opacity-60">({contacts.length})</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="px-6 py-6 max-w-3xl">
          {activeTab === 'details' && (
            <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-6">
              <dl>
                <DetailRow label="Registration No" value={client.registrationNo ?? '—'} />
                <DetailRow label="Tax No" value={client.taxNo ?? '—'} />
                <DetailRow label="Billing Model" value={BILLING_LABELS[client.billingModel]} />
                <DetailRow label="Client Group" value={client.clientGroupId ?? '—'} />
                <DetailRow label="Status" value={<StatusBadge status={client.status} />} />
              </dl>
            </div>
          )}

          {activeTab === 'rate-overrides' && clientId && (
            <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-6">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Staff Rate Overrides</h2>
              <ClientRateOverrides clientId={clientId} />
            </div>
          )}

          {activeTab === 'contacts' && (
            <div>
              {contacts.length === 0 ? (
                <div className="text-center py-16">
                  <User className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
                  <p className="text-[var(--ff-text-secondary)] font-medium">No contacts yet</p>
                  <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
                    Contacts will appear here once added.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-bg-secondary)]">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)]">
                        <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Name</th>
                        <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Email</th>
                        <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Role</th>
                        <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Primary</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contacts.map((contact) => (
                        <tr
                          key={contact.id}
                          className="border-b border-[var(--ff-border-primary)] last:border-0"
                        >
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2">
                              <User className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                              <span className="font-medium text-[var(--ff-text-primary)]">{contact.name}</span>
                            </div>
                            {contact.phone && (
                              <div className="flex items-center gap-1.5 mt-0.5 text-xs text-[var(--ff-text-tertiary)]">
                                <Phone className="h-3 w-3" />
                                {contact.phone}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 text-[var(--ff-text-secondary)]">
                            {contact.email ? (
                              <div className="flex items-center gap-1.5">
                                <Mail className="h-3.5 w-3.5 text-[var(--ff-text-tertiary)]" />
                                {contact.email}
                              </div>
                            ) : '—'}
                          </td>
                          <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{contact.role ?? '—'}</td>
                          <td className="py-3 px-4">
                            {contact.isPrimary ? (
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-teal-500/20 text-teal-400">
                                Primary
                              </span>
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
          )}
        </div>
      </div>
    </AppLayout>
  );
}
