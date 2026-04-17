/**
 * Customer Detail Page
 * Tabs: Overview | Delivery Addresses | Contacts
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, User, MapPin, Users, Activity, Loader2, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { DeliveryAddressesTab } from '@/components/accounting/customers/DeliveryAddressesTab';
import { ContactsTab } from '@/components/accounting/customers/ContactsTab';
import { RecordNavigation } from '@/components/accounting/RecordNavigation';

interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  contact_person: string | null;
  vat_number: string | null;
  registration_number: string | null;
  payment_terms: number | null;
  credit_limit: number | null;
  is_active: boolean;
  created_at: string;
}

type Tab = 'overview' | 'addresses' | 'contacts' | 'activity';

const TABS: { id: Tab; label: string; icon: typeof User }[] = [
  { id: 'overview', label: 'Overview', icon: User },
  { id: 'addresses', label: 'Delivery Addresses', icon: MapPin },
  { id: 'contacts', label: 'Contacts', icon: Users },
  { id: 'activity', label: 'Activity', icon: Activity },
];

interface ActivityRow {
  id: string;
  reference: string;
  date: Date | string;
  due_date?: Date | string | null;
  total_amount: number | string;
  status: string;
  type: 'invoice' | 'payment' | 'credit_note';
}

const TYPE_LABELS: Record<ActivityRow['type'], string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  credit_note: 'Credit Note',
};

const TYPE_COLORS: Record<ActivityRow['type'], string> = {
  invoice: 'bg-blue-500/20 text-blue-400',
  payment: 'bg-teal-500/20 text-teal-400',
  credit_note: 'bg-orange-500/20 text-orange-400',
};

const TYPE_PATHS: Record<ActivityRow['type'], string> = {
  invoice: '/accounting/customer-invoices',
  payment: '/accounting/customer-payments',
  credit_note: '/accounting/credit-notes',
};

function toDateStr(val: Date | string | null | undefined): string {
  if (!val) return '—';
  if (val instanceof Date) return val.toLocaleDateString('en-ZA');
  const s = String(val);
  return s.split('T')[0] ?? s;
}

export default function CustomerDetailPage() {
  const router = useRouter();
  const { customerId } = router.query;
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState('');
  const [activityLoaded, setActivityLoaded] = useState(false);

  useEffect(() => {
    if (!customerId) return;
    void loadCustomer();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const loadActivity = useCallback(async () => {
    if (!customerId || activityLoaded) return;
    setActivityLoading(true);
    setActivityError('');
    try {
      const res = await apiFetch(`/api/accounting/customers?id=${customerId as string}&include=activity`);
      const json = await res.json() as { data?: ActivityRow[] } | ActivityRow[];
      const data = (json as { data?: ActivityRow[] }).data ?? (json as ActivityRow[]);
      setActivity(Array.isArray(data) ? data : []);
      setActivityLoaded(true);
    } catch {
      setActivityError('Failed to load activity');
    } finally {
      setActivityLoading(false);
    }
  }, [customerId, activityLoaded]);

  useEffect(() => {
    if (activeTab === 'activity') {
      void loadActivity();
    }
  }, [activeTab, loadActivity]);

  const loadCustomer = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/customers?id=${customerId as string}`);
      const json = await res.json() as { data?: Customer | Customer[] } | Customer | Customer[];
      const data = (json as { data?: Customer | Customer[] }).data ?? json;
      if (Array.isArray(data)) {
        const match = data.find((c: Customer) => c.id === customerId);
        setCustomer(match ?? null);
        if (!match) setError('Customer not found');
      } else {
        setCustomer(data as Customer);
      }
    } catch {
      setError('Failed to load customer');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        </div>
      </AppLayout>
    );
  }

  if (!customer) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh] flex-col">
          <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
          <p className="text-[var(--ff-text-secondary)]">{error || 'Customer not found'}</p>
          <Link href="/accounting/customers" className="mt-4 text-sm text-blue-400 hover:text-blue-300">
            Back to Customers
          </Link>
        </div>
      </AppLayout>
    );
  }

  const fields: { label: string; value: string | number | null | undefined; highlight?: boolean }[] = [
    { label: 'Name', value: customer.name, highlight: true },
    { label: 'Email', value: customer.email },
    { label: 'Phone', value: customer.phone },
    { label: 'Contact Person', value: customer.contact_person },
    { label: 'VAT Number', value: customer.vat_number },
    { label: 'Registration Number', value: customer.registration_number },
    { label: 'Payment Terms', value: customer.payment_terms ? `${customer.payment_terms} days` : null },
    {
      label: 'Credit Limit',
      value: customer.credit_limit != null
        ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(Number(customer.credit_limit))
        : null,
    },
  ];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <Link href="/accounting/customers" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400">
              <ArrowLeft className="h-4 w-4" /> Back to Customers
            </Link>
            {typeof customerId === 'string' && (
              <RecordNavigation entity="customers" currentId={customerId} basePath="/accounting/customers" />
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <User className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{customer.name}</h1>
              {customer.email && <p className="text-sm text-[var(--ff-text-secondary)]">{customer.email}</p>}
            </div>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${customer.is_active ? 'bg-teal-500/20 text-teal-400' : 'bg-gray-500/20 text-gray-400'}`}>
              {customer.is_active ? 'Active' : 'Inactive'}
            </span>
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 mt-4 border-b border-[var(--ff-border-light)] -mx-6 px-6">
            {TABS.map(tab => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${activeTab === tab.id ? 'border-blue-500 text-blue-400' : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Tab content */}
        <div className="p-6">
          {activeTab === 'overview' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {fields.map((f, i) => (
                  <div key={i} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                    <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">{f.label}</p>
                    <p className={`text-lg font-semibold mt-1 ${f.highlight ? 'text-blue-400' : 'text-[var(--ff-text-primary)]'}`}>
                      {f.value || '—'}
                    </p>
                  </div>
                ))}
              </div>

              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-2">Status</p>
                <div className="flex items-center gap-2">
                  {customer.is_active
                    ? <><CheckCircle2 className="h-5 w-5 text-teal-400" /><span className="text-sm text-teal-400 font-medium">Active Customer</span></>
                    : <><XCircle className="h-5 w-5 text-gray-600 dark:text-gray-400" /><span className="text-sm text-gray-600 dark:text-gray-400 font-medium">Inactive Customer</span></>}
                </div>
                {customer.created_at && (
                  <p className="text-xs text-[var(--ff-text-tertiary)] mt-2">
                    Created: {customer.created_at.split('T')[0]}
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'addresses' && typeof customerId === 'string' && (
            <DeliveryAddressesTab customerId={customerId} />
          )}

          {activeTab === 'contacts' && typeof customerId === 'string' && (
            <ContactsTab customerId={customerId} />
          )}

          {activeTab === 'activity' && (
            <div>
              {activityLoading && (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
                </div>
              )}
              {activityError && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
                  <AlertCircle className="h-4 w-4" /> {activityError}
                </div>
              )}
              {!activityLoading && activity.length === 0 && !activityError && (
                <div className="text-center py-12 text-[var(--ff-text-secondary)]">
                  No transactions yet
                </div>
              )}
              {!activityLoading && activity.length > 0 && (
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-light)]">
                        <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Date</th>
                        <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Type</th>
                        <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Reference</th>
                        <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Amount</th>
                        <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activity.map(row => (
                        <tr
                          key={`${row.type}-${row.id}`}
                          className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)] transition-colors cursor-pointer"
                          onClick={() => { void router.push(`${TYPE_PATHS[row.type]}/${row.id}`); }}
                        >
                          <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{toDateStr(row.date)}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[row.type]}`}>
                              {TYPE_LABELS[row.type]}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-mono text-[var(--ff-text-primary)]">{row.reference}</td>
                          <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                            {formatCurrency(Number(row.total_amount))}
                          </td>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/20 text-gray-600 dark:text-gray-400">
                              {row.status}
                            </span>
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
