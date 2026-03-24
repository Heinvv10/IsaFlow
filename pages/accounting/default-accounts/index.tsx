/**
 * Default Accounts Configuration
 * Sage equivalent: Accounts > Default Accounts
 * Configure which GL accounts are used by default for various transaction types
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Settings, Loader2, AlertCircle, Save } from 'lucide-react';

interface GLAccount {
  id: string;
  account_code: string;
  account_name: string;
}

interface DefaultAccountMapping {
  key: string;
  label: string;
  description: string;
  accountId: string;
  category: string;
}

const DEFAULT_MAPPINGS: Omit<DefaultAccountMapping, 'accountId'>[] = [
  // Sales
  { key: 'sales_revenue', label: 'Sales Revenue', description: 'Default revenue account for customer invoices', category: 'Sales' },
  { key: 'sales_vat_output', label: 'VAT Output', description: 'VAT collected on sales', category: 'Sales' },
  { key: 'accounts_receivable', label: 'Accounts Receivable', description: 'Trade debtors control account', category: 'Sales' },
  { key: 'sales_discount', label: 'Sales Discount', description: 'Discounts given to customers', category: 'Sales' },
  // Purchases
  { key: 'cost_of_sales', label: 'Cost of Sales', description: 'Default COGS/materials account', category: 'Purchases' },
  { key: 'purchase_vat_input', label: 'VAT Input', description: 'VAT paid on purchases', category: 'Purchases' },
  { key: 'accounts_payable', label: 'Accounts Payable', description: 'Trade creditors control account', category: 'Purchases' },
  // Banking
  { key: 'primary_bank', label: 'Primary Bank Account', description: 'Main operating bank account', category: 'Banking' },
  { key: 'petty_cash', label: 'Petty Cash', description: 'Petty cash account', category: 'Banking' },
  // Other
  { key: 'retained_earnings', label: 'Retained Earnings', description: 'Year-end closing account', category: 'Year-End' },
  { key: 'opening_balance_equity', label: 'Opening Balance Equity', description: 'Used for opening balances during setup', category: 'Year-End' },
  { key: 'rounding', label: 'Rounding', description: 'Rounding differences', category: 'Other' },
];

export default function DefaultAccountsPage() {
  const [glAccounts, setGlAccounts] = useState<GLAccount[]>([]);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [acctRes, mapRes] = await Promise.all([
        fetch('/api/accounting/chart-of-accounts?level=3'),
        fetch('/api/accounting/default-accounts'),
      ]);
      const acctJson = await acctRes.json();
      const mapJson = await mapRes.json();
      setGlAccounts((acctJson.data || acctJson).accounts || []);
      setMappings((mapJson.data || mapJson).mappings || {});
    } catch {
      setMessage({ type: 'error', text: 'Failed to load configuration' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSave = async () => {
    setIsSaving(true);
    setMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/accounting/default-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings }),
      });
      if (res.ok) {
        setMessage({ type: 'success', text: 'Default accounts saved' });
      } else {
        const json = await res.json();
        setMessage({ type: 'error', text: json.message || 'Failed to save' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Save request failed' });
    } finally {
      setIsSaving(false);
    }
  };

  const categories = [...new Set(DEFAULT_MAPPINGS.map(m => m.category))];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-500/10">
                  <Settings className="h-6 w-6 text-amber-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Default Accounts</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    Configure GL accounts for automatic transaction posting
                  </p>
                </div>
              </div>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-2 text-sm"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save Changes
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-4xl">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
            </div>
          ) : (
            <div className="space-y-8">
              {message.text && (
                <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${
                  message.type === 'error' ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'
                }`}>
                  <AlertCircle className="h-4 w-4" />
                  {message.text}
                </div>
              )}

              {categories.map(cat => (
                <div key={cat}>
                  <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-3">{cat}</h2>
                  <div className="space-y-3">
                    {DEFAULT_MAPPINGS.filter(m => m.category === cat).map(mapping => (
                      <div key={mapping.key} className="flex items-center gap-4 p-4 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)]">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-[var(--ff-text-primary)]">{mapping.label}</p>
                          <p className="text-xs text-[var(--ff-text-tertiary)]">{mapping.description}</p>
                        </div>
                        <select
                          value={mappings[mapping.key] || ''}
                          onChange={(e) => setMappings(prev => ({ ...prev, [mapping.key]: e.target.value }))}
                          className="w-80 px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
                        >
                          <option value="">Not configured</option>
                          {glAccounts.map(a => (
                            <option key={a.id} value={a.id}>{a.account_code} — {a.account_name}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
