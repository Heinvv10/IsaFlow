/**
 * Inline entity creation modal — create GL Accounts, Suppliers, or Customers
 * directly from the bank transaction allocation dropdown (Sage-style).
 *
 * When creating GL accounts, suggests account code/name/type based on
 * the bank transaction description using keyword matching.
 */

import { useState, useEffect, useCallback } from 'react';
import { Plus, X, Loader2, Sparkles, Check } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';
import type { AllocType, SelectOption } from './BankTxTable';

interface Props {
  type: AllocType;
  /** Bank transaction description — used to suggest GL account details */
  transactionDescription?: string;
  /** Existing GL accounts — used to detect duplicates and select existing ones */
  existingAccounts?: SelectOption[];
  onClose: () => void;
  onCreated: (entity: { id: string; code?: string; name: string }) => void;
}

const ACCOUNT_TYPES = [
  { value: 'expense', label: 'Expense', nb: 'debit' },
  { value: 'asset', label: 'Asset', nb: 'debit' },
  { value: 'liability', label: 'Liability', nb: 'credit' },
  { value: 'revenue', label: 'Revenue', nb: 'credit' },
  { value: 'equity', label: 'Equity', nb: 'credit' },
];

/* ── Suggestion mapping: keywords → GL account suggestion ── */
interface GLSuggestion {
  code: string;
  name: string;
  type: string;
}

const DESCRIPTION_SUGGESTIONS: { keywords: string[]; suggestion: GLSuggestion }[] = [
  // Expenses
  { keywords: ['bank charge', 'bank fee', 'service fee', 'monthly fee', 'account fee'],
    suggestion: { code: '5700', name: 'Bank Charges', type: 'expense' } },
  { keywords: ['interest', 'credit interest'],
    suggestion: { code: '4310', name: 'Interest Received', type: 'revenue' } },
  { keywords: ['salary', 'wage', 'payroll', 'nett pay'],
    suggestion: { code: '5200', name: 'Salaries & Wages', type: 'expense' } },
  { keywords: ['cleaning', 'bidvest cleaning', 'hygiene'],
    suggestion: { code: '5610', name: 'Cleaning & Hygiene', type: 'expense' } },
  { keywords: ['electricity', 'eskom', 'power', 'prepaid elec'],
    suggestion: { code: '5620', name: 'Electricity', type: 'expense' } },
  { keywords: ['water', 'municipal water', 'water & sewer'],
    suggestion: { code: '5625', name: 'Water & Sewerage', type: 'expense' } },
  { keywords: ['internet', 'fibre', 'dark fibre', 'velocityfibre', 'frogfoot', 'vumatel', 'broadband', 'connectivity'],
    suggestion: { code: '5630', name: 'Internet & Connectivity', type: 'expense' } },
  { keywords: ['telephone', 'telkom', 'vodacom', 'mtn', 'cell c', 'airtime', 'cellphone'],
    suggestion: { code: '5640', name: 'Telephone & Communications', type: 'expense' } },
  { keywords: ['insurance', 'premium'],
    suggestion: { code: '5650', name: 'Insurance', type: 'expense' } },
  { keywords: ['rent', 'lease', 'office rental'],
    suggestion: { code: '5660', name: 'Rent & Lease Payments', type: 'expense' } },
  { keywords: ['fuel', 'petrol', 'diesel', 'engen', 'sasol', 'shell', 'bp ', 'caltex', 'total '],
    suggestion: { code: '5400', name: 'Transport & Fuel', type: 'expense' } },
  { keywords: ['stationery', 'office supplies', 'cartridge', 'toner'],
    suggestion: { code: '5670', name: 'Stationery & Office Supplies', type: 'expense' } },
  { keywords: ['repair', 'maintenance', 'service call', 'fix'],
    suggestion: { code: '5680', name: 'Repairs & Maintenance', type: 'expense' } },
  { keywords: ['subscription', 'software', 'saas', 'license', 'licence', 'microsoft', 'google', 'amazon', 'aws', 'adobe', 'zoom'],
    suggestion: { code: '5690', name: 'Software & Subscriptions', type: 'expense' } },
  { keywords: ['accounting', 'audit', 'bookkeep'],
    suggestion: { code: '5710', name: 'Accounting & Audit Fees', type: 'expense' } },
  { keywords: ['legal', 'attorney', 'lawyer'],
    suggestion: { code: '5720', name: 'Legal Fees', type: 'expense' } },
  { keywords: ['advertising', 'marketing', 'advert', 'promotion', 'google ads', 'facebook'],
    suggestion: { code: '5730', name: 'Advertising & Marketing', type: 'expense' } },
  { keywords: ['training', 'course', 'seminar', 'conference'],
    suggestion: { code: '5740', name: 'Training & Development', type: 'expense' } },
  { keywords: ['sars', 'tax payment', 'paye', 'uif', 'sdl', 'vat payment'],
    suggestion: { code: '2130', name: 'SARS Payments', type: 'liability' } },
  { keywords: ['medical', 'medical aid', 'discovery', 'bonitas'],
    suggestion: { code: '5210', name: 'Medical Aid Contributions', type: 'expense' } },
  { keywords: ['security', 'guard', 'adt ', 'chubb', 'armed response'],
    suggestion: { code: '5750', name: 'Security Services', type: 'expense' } },
  { keywords: ['travel', 'flight', 'hotel', 'accommodation', 'uber', 'bolt'],
    suggestion: { code: '5760', name: 'Travel & Accommodation', type: 'expense' } },
  { keywords: ['meal', 'entertainment', 'restaurant', 'catering', 'food'],
    suggestion: { code: '5770', name: 'Meals & Entertainment', type: 'expense' } },
  { keywords: ['courier', 'postage', 'delivery', 'shipping'],
    suggestion: { code: '5780', name: 'Courier & Postage', type: 'expense' } },
  { keywords: ['depreciation'],
    suggestion: { code: '5800', name: 'Depreciation Expense', type: 'expense' } },
  { keywords: ['makro', 'woolworths', 'checkers', 'pick n pay', 'spar', 'shoprite', 'groceries', 'supplies'],
    suggestion: { code: '5100', name: 'Materials & Supplies', type: 'expense' } },
  { keywords: ['subcontract', 'contractor'],
    suggestion: { code: '5300', name: 'Subcontractor Costs', type: 'expense' } },
  { keywords: ['equipment', 'tool', 'machinery'],
    suggestion: { code: '5500', name: 'Equipment Costs', type: 'expense' } },
  // Revenue
  { keywords: ['eft rec', 'payment received', 'deposit', 'receipt'],
    suggestion: { code: '4100', name: 'Service Revenue', type: 'revenue' } },
  { keywords: ['refund received', 'cashback'],
    suggestion: { code: '4300', name: 'Other Income', type: 'revenue' } },
];

/** Default code ranges per account type when no description match */
const TYPE_CODE_RANGES: Record<string, { start: number; name: string }> = {
  asset:     { start: 1300, name: 'Other Asset' },
  liability: { start: 2200, name: 'Other Liability' },
  equity:    { start: 3300, name: 'Other Equity' },
  revenue:   { start: 4400, name: 'Other Revenue' },
  expense:   { start: 5900, name: 'Other Expense' },
};

function suggestFromDescription(description?: string): GLSuggestion | null {
  if (!description) return null;
  const lower = description.toLowerCase();
  for (const entry of DESCRIPTION_SUGGESTIONS) {
    if (entry.keywords.some(kw => lower.includes(kw))) {
      return entry.suggestion;
    }
  }
  return null;
}

function suggestFromType(accountType: string): GLSuggestion {
  const range = TYPE_CODE_RANGES[accountType] ?? TYPE_CODE_RANGES.expense!;
  return { code: String(range!.start), name: range!.name, type: accountType };
}

const INPUT = 'w-full px-3 py-2 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-primary)] focus:outline-none focus:border-teal-500';
const LABEL = 'text-xs text-[var(--ff-text-tertiary)] mb-1 block';

export function CreateEntityModal({ type, transactionDescription, existingAccounts, onClose, onCreated }: Props) {
  const [saving, setSaving] = useState(false);

  // Account fields
  const [acctCode, setAcctCode] = useState('');
  const [acctName, setAcctName] = useState('');
  const [acctType, setAcctType] = useState('expense');

  // Suggestion state
  const [suggestion, setSuggestion] = useState<GLSuggestion | null>(null);
  const [suggestionApplied, setSuggestionApplied] = useState(false);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);

  // Supplier fields
  const [supName, setSupName] = useState('');
  const [supEmail, setSupEmail] = useState('');
  const [supPhone, setSupPhone] = useState('');

  // Customer fields
  const [custName, setCustName] = useState('');
  const [custEmail, setCustEmail] = useState('');
  const [custPhone, setCustPhone] = useState('');

  // Generate suggestion on mount (from description) or when type changes
  useEffect(() => {
    if (type !== 'account' || suggestionDismissed) return;

    const descSuggestion = suggestFromDescription(transactionDescription);
    if (descSuggestion) {
      setSuggestion(descSuggestion);
      setSuggestionApplied(false);
    }
  // Run only on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When account type changes and no description suggestion, suggest from type
  const handleTypeChange = useCallback((newType: string) => {
    setAcctType(newType);
    if (type !== 'account' || suggestionDismissed) return;

    const descSuggestion = suggestFromDescription(transactionDescription);
    if (descSuggestion && descSuggestion.type === newType) {
      setSuggestion(descSuggestion);
      setSuggestionApplied(false);
    } else if (!descSuggestion || descSuggestion.type !== newType) {
      // Suggest a default code for this type
      const typeSuggestion = suggestFromType(newType);
      setSuggestion(typeSuggestion);
      setSuggestionApplied(false);
    }
  }, [type, transactionDescription, suggestionDismissed]);

  /** Check if a suggestion matches an existing GL account */
  const findExistingAccount = useCallback((s: GLSuggestion | null) => {
    if (!s || !existingAccounts?.length) return null;
    return existingAccounts.find(a => a.code === s.code) || null;
  }, [existingAccounts]);

  const applySuggestion = useCallback(() => {
    if (!suggestion) return;
    // If the account already exists, select it directly instead of creating
    const existing = findExistingAccount(suggestion);
    if (existing) {
      notify.success(`Selected existing account: ${existing.code} ${existing.name}`);
      onCreated({ id: existing.id, code: existing.code, name: existing.name });
      return;
    }
    setAcctCode(suggestion.code);
    setAcctName(suggestion.name);
    setAcctType(suggestion.type);
    setSuggestionApplied(true);
  }, [suggestion, findExistingAccount, onCreated]);

  const dismissSuggestion = useCallback(() => {
    setSuggestion(null);
    setSuggestionDismissed(true);
    setSuggestionApplied(false);
  }, []);

  const title = type === 'account' ? 'New GL Account'
    : type === 'supplier' ? 'New Supplier' : 'New Customer';

  const canSave = type === 'account'
    ? !!(acctCode.trim() && acctName.trim())
    : type === 'supplier'
      ? !!(supName.trim() && supEmail.trim())
      : !!custName.trim();

  const handleSave = async () => {
    setSaving(true);
    try {
      let entity: { id: string; code?: string; name: string };

      if (type === 'account') {
        const nb = ACCOUNT_TYPES.find(t => t.value === acctType)?.nb || 'debit';
        const res = await apiFetch('/api/accounting/chart-of-accounts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountCode: acctCode.trim(), accountName: acctName.trim(),
            accountType: acctType, normalBalance: nb,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.message || json.error?.message || 'Failed to create account');
        const d = json.data;
        entity = { id: d.id, code: d.accountCode, name: d.accountName };
      } else if (type === 'supplier') {
        const res = await apiFetch('/api/suppliers', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: {
            name: supName.trim(),
            email: supEmail.trim(),
            phone: supPhone.trim() || undefined,
          }}),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.message || 'Failed to create supplier');
        const d = json.data;
        entity = { id: String(d.id), code: d.code, name: supName.trim() };
      } else {
        const res = await apiFetch('/api/clients', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company_name: custName.trim(),
            email: custEmail.trim() || undefined,
            phone: custPhone.trim() || undefined,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.message || 'Failed to create customer');
        const d = json.data;
        entity = { id: d.id, name: custName.trim() };
      }

      notify.success(`${title.replace('New ', '')} created`);
      onCreated(entity);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Failed to create');
    } finally {
      setSaving(false);
    }
  };

  const nb = ACCOUNT_TYPES.find(t => t.value === acctType)?.nb;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--ff-border-light)]">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-teal-400" />
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">{title}</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          {type === 'account' && (
            <>
              {/* AI Suggestion Banner */}
              {suggestion && !suggestionApplied && (() => {
                const existingMatch = findExistingAccount(suggestion);
                return (
                  <div className={`flex items-start gap-2 p-3 rounded-lg border ${existingMatch ? 'bg-amber-500/10 border-amber-500/30' : 'bg-teal-500/10 border-teal-500/30'}`}>
                    <Sparkles className={`h-4 w-4 mt-0.5 flex-shrink-0 ${existingMatch ? 'text-amber-400' : 'text-teal-400'}`} />
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-medium mb-1 ${existingMatch ? 'text-amber-300' : 'text-teal-300'}`}>
                        {existingMatch ? 'Existing account found' : 'Suggested from transaction'}
                      </p>
                      <p className="text-sm text-[var(--ff-text-primary)]">
                        <span className="font-mono">{suggestion.code}</span> — {existingMatch ? existingMatch.name : suggestion.name}
                        <span className="text-xs text-[var(--ff-text-tertiary)] ml-1">
                          ({ACCOUNT_TYPES.find(t => t.value === suggestion.type)?.label})
                        </span>
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button onClick={applySuggestion} title={existingMatch ? 'Use this account' : 'Accept suggestion'}
                        className={`px-2 py-1 rounded text-xs font-medium ${existingMatch ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-400' : 'hover:bg-teal-500/20 text-teal-400'}`}>
                        {existingMatch ? 'Use' : <Check className="h-4 w-4" />}
                      </button>
                      <button onClick={dismissSuggestion} title="Dismiss"
                        className="p-1 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })()}
              {suggestion && suggestionApplied && (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400">
                  <Check className="h-3.5 w-3.5" />
                  Suggestion applied — you can still edit the fields below
                </div>
              )}

              {/* Transaction context */}
              {transactionDescription && (
                <div className="text-xs text-[var(--ff-text-tertiary)] bg-[var(--ff-bg-primary)] rounded px-3 py-2 truncate">
                  Transaction: <span className="text-[var(--ff-text-secondary)]">{transactionDescription}</span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>Account Code *</label>
                  <input type="text" value={acctCode} onChange={e => setAcctCode(e.target.value)}
                    placeholder="e.g. 5250" className={`${INPUT} font-mono`} autoFocus />
                </div>
                <div>
                  <label className={LABEL}>Type *</label>
                  <select value={acctType} onChange={e => handleTypeChange(e.target.value)} className={INPUT}>
                    {ACCOUNT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className={LABEL}>Account Name *</label>
                <input type="text" value={acctName} onChange={e => setAcctName(e.target.value)}
                  placeholder="e.g. Cleaning & Maintenance" className={INPUT} />
              </div>
              <div className="flex items-center gap-2 text-xs text-[var(--ff-text-tertiary)]">
                Normal balance:&nbsp;
                <span className={nb === 'debit' ? 'text-red-400' : 'text-teal-400'}>
                  {nb === 'debit' ? 'Debit' : 'Credit'}
                </span>
              </div>
            </>
          )}

          {type === 'supplier' && (
            <>
              <div>
                <label className={LABEL}>Supplier Name *</label>
                <input type="text" value={supName} onChange={e => setSupName(e.target.value)}
                  placeholder="e.g. ACME Trading" className={INPUT} autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>Email *</label>
                  <input type="email" value={supEmail} onChange={e => setSupEmail(e.target.value)}
                    placeholder="info@supplier.co.za" className={INPUT} />
                </div>
                <div>
                  <label className={LABEL}>Phone</label>
                  <input type="tel" value={supPhone} onChange={e => setSupPhone(e.target.value)}
                    placeholder="012 345 6789" className={INPUT} />
                </div>
              </div>
            </>
          )}

          {type === 'customer' && (
            <>
              <div>
                <label className={LABEL}>Company Name *</label>
                <input type="text" value={custName} onChange={e => setCustName(e.target.value)}
                  placeholder="e.g. Fibertime" className={INPUT} autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>Email</label>
                  <input type="email" value={custEmail} onChange={e => setCustEmail(e.target.value)}
                    placeholder="client@example.com" className={INPUT} />
                </div>
                <div>
                  <label className={LABEL}>Phone</label>
                  <input type="tel" value={custPhone} onChange={e => setCustPhone(e.target.value)}
                    placeholder="012 345 6789" className={INPUT} />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--ff-border-light)]">
          <button onClick={onClose}
            className="px-4 py-1.5 rounded text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || !canSave}
            className="px-4 py-1.5 rounded bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium flex items-center gap-1.5">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
