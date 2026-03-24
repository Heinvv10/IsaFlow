/**
 * Create Rule Modal — opens pre-filled from a bank transaction row.
 * Extracts a recurring pattern from the description, lets user pick GL account,
 * allocation type (account/supplier/customer), and shows a live preview.
 */

import { useState, useEffect, useRef } from 'react';
import { X, Search, BookmarkPlus, Loader2 } from 'lucide-react';
import { toast } from 'react-hot-toast';
import type { BankTx, SelectOption } from './BankTxTable';
import type { RuleMatchType, RuleVatCode } from '@/modules/accounting/types/bank.types';

const VAT_OPTIONS: { value: RuleVatCode; label: string }[] = [
  { value: 'none', label: 'No VAT' },
  { value: 'standard', label: 'Standard 15%' },
  { value: 'zero_rated', label: 'Zero Rated' },
  { value: 'exempt', label: 'Exempt' },
];

type AllocType = 'account' | 'supplier' | 'customer';

interface Props {
  transaction: BankTx;
  bankAccountId: string;
  glAccounts: SelectOption[];
  suppliers?: SelectOption[];
  clients?: SelectOption[];
  onClose: () => void;
  onCreated: () => void;
}

/**
 * Strip unique references, dates, card numbers from a transaction description
 * to extract the recurring core pattern for rule matching.
 * Exported so other components (e.g. allocation flow) can derive the same pattern.
 */
export function extractPattern(desc: string): string {
  let p = desc;
  p = p.replace(/[a-f0-9]{8,}/gi, '');
  p = p.replace(/\d{4}[-/]\d{2}[-/]\d{2}/g, '');
  p = p.replace(/\d{2}[-/]\d{2}[-/]\d{4}/g, '');
  p = p.replace(/\d{8}/g, '');
  p = p.replace(/\d{4,}/g, '');
  p = p.replace(/\/Cmd\s+\w\b/gi, '');
  p = p.replace(/\s{2,}/g, ' ').trim();
  p = p.replace(/[/\s]+$/, '');
  return p;
}

/** Reusable searchable dropdown for GL accounts, suppliers, or customers */
function EntityPicker({
  label, placeholder, options, selected, onSelect,
}: {
  label: string; placeholder: string; options: SelectOption[];
  selected: SelectOption | null; onSelect: (o: SelectOption) => void;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const filtered = search
    ? options.filter(o =>
        (o.code || '').toLowerCase().includes(search.toLowerCase()) ||
        o.name.toLowerCase().includes(search.toLowerCase())
      )
    : options;

  return (
    <div ref={ref}>
      <label className="text-xs text-[var(--ff-text-tertiary)] mb-1 block">{label}</label>
      <div className="relative">
        <button
          onClick={() => { setOpen(!open); setSearch(''); }}
          className={`w-full text-left px-3 py-2 rounded border text-sm ${
            selected
              ? 'bg-[var(--ff-bg-primary)] border-[var(--ff-border-light)] text-[var(--ff-text-primary)]'
              : 'bg-[var(--ff-bg-primary)] border-amber-500/40 text-amber-400'
          }`}
        >
          {selected ? `${selected.code || ''} ${selected.name}`.trim() : placeholder}
        </button>
        {open && (
          <div className="absolute z-50 top-full left-0 mt-1 w-full bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg shadow-xl">
            <div className="p-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[var(--ff-text-tertiary)]" />
                <input
                  type="text"
                  placeholder={`Search...`}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full pl-7 pr-2 py-1.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)] focus:outline-none focus:border-blue-500"
                  autoFocus
                />
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {filtered.slice(0, 50).map(o => (
                <button
                  key={o.id}
                  onClick={() => { onSelect(o); setOpen(false); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--ff-bg-primary)] text-xs flex items-center gap-2"
                >
                  {o.code && <span className="font-mono text-[var(--ff-text-tertiary)] w-10 shrink-0">{o.code}</span>}
                  <span className="text-[var(--ff-text-primary)] truncate">{o.name}</span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="px-3 py-2 text-xs text-[var(--ff-text-tertiary)]">No results found</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function CreateRuleModal({ transaction, bankAccountId, glAccounts, suppliers = [], clients = [], onClose, onCreated }: Props) {
  const [pattern, setPattern] = useState(() => extractPattern(transaction.description || ''));
  const [matchType, setMatchType] = useState<RuleMatchType>('contains');
  const [ruleName, setRuleName] = useState(() => extractPattern(transaction.description || ''));
  const [autoCreateEntry, setAutoCreateEntry] = useState(false);

  const [allocType, setAllocType] = useState<AllocType>('account');
  const [vatCode, setVatCode] = useState<RuleVatCode>('none');
  const [selectedGl, setSelectedGl] = useState<SelectOption | null>(null);
  const [selectedSupplier, setSelectedSupplier] = useState<SelectOption | null>(null);
  const [selectedClient, setSelectedClient] = useState<SelectOption | null>(null);

  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Live preview — debounced query as user edits pattern
  useEffect(() => {
    if (!pattern.trim()) { setMatchCount(0); return; }
    setPreviewLoading(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ pattern, matchType, bankAccountId });
        const res = await fetch(`/api/accounting/bank-rules-preview?${params}`);
        const json = await res.json();
        setMatchCount(json.data?.matchCount ?? 0);
      } catch {
        setMatchCount(null);
      } finally {
        setPreviewLoading(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [pattern, matchType, bankAccountId]);

  // Clear entity selection when switching alloc type
  useEffect(() => {
    setSelectedSupplier(null);
    setSelectedClient(null);
  }, [allocType]);

  const needsGlAccount = allocType === 'account';

  const handleSave = async () => {
    if (!pattern.trim()) { toast.error('Pattern is required'); return; }
    if (needsGlAccount && !selectedGl) { toast.error('Select a GL account'); return; }
    if (allocType === 'supplier' && !selectedSupplier) { toast.error('Select a supplier'); return; }
    if (allocType === 'customer' && !selectedClient) { toast.error('Select a customer'); return; }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        ruleName: ruleName.trim() || pattern.trim(),
        matchField: 'description',
        matchType,
        matchPattern: pattern.trim(),
        autoCreateEntry,
        vatCode,
      };
      // GL account only needed for 'account' type — supplier/customer use AP/AR automatically
      if (needsGlAccount && selectedGl) body.glAccountId = selectedGl.id;
      if (allocType === 'supplier' && selectedSupplier) body.supplierId = selectedSupplier.id;
      if (allocType === 'customer' && selectedClient) body.clientId = selectedClient.id;

      const res = await fetch('/api/accounting/bank-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || 'Failed to create rule');
      toast.success('Rule created');
      onCreated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create rule');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl w-full max-w-lg mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--ff-border-light)]">
          <div className="flex items-center gap-2">
            <BookmarkPlus className="h-4 w-4 text-yellow-400" />
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Create Categorisation Rule</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Source description */}
          <div>
            <label className="text-xs text-[var(--ff-text-tertiary)] mb-1 block">Source Description</label>
            <p className="text-xs text-[var(--ff-text-secondary)] bg-[var(--ff-bg-primary)] rounded px-3 py-2 font-mono break-all">
              {transaction.description || '\u2014'}
            </p>
          </div>

          {/* Pattern */}
          <div>
            <label className="text-xs text-[var(--ff-text-tertiary)] mb-1 block">Match Pattern</label>
            <input
              type="text"
              value={pattern}
              onChange={e => setPattern(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-primary)] focus:outline-none focus:border-blue-500"
            />
            <div className="flex items-center gap-2 mt-1.5">
              {previewLoading ? (
                <Loader2 className="h-3 w-3 animate-spin text-[var(--ff-text-tertiary)]" />
              ) : matchCount !== null ? (
                <span className={`text-xs font-medium ${matchCount > 0 ? 'text-emerald-400' : 'text-[var(--ff-text-tertiary)]'}`}>
                  Would match <strong>{matchCount}</strong> transaction{matchCount !== 1 ? 's' : ''}
                </span>
              ) : null}
            </div>
          </div>

          {/* Match type */}
          <div>
            <label className="text-xs text-[var(--ff-text-tertiary)] mb-1 block">Match Type</label>
            <select
              value={matchType}
              onChange={e => setMatchType(e.target.value as RuleMatchType)}
              className="w-full px-3 py-2 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-primary)]"
            >
              <option value="contains">Contains</option>
              <option value="starts_with">Starts With</option>
              <option value="ends_with">Ends With</option>
              <option value="exact">Exact Match</option>
            </select>
          </div>

          {/* Allocation Type */}
          <div>
            <label className="text-xs text-[var(--ff-text-tertiary)] mb-1 block">Allocation Type</label>
            <div className="flex gap-1">
              {(['account', 'supplier', 'customer'] as AllocType[]).map(t => (
                <button
                  key={t}
                  onClick={() => setAllocType(t)}
                  className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    allocType === t
                      ? 'bg-emerald-600 text-white'
                      : 'bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] border border-[var(--ff-border-light)]'
                  }`}
                >
                  {t === 'account' ? 'Account' : t === 'supplier' ? 'Supplier' : 'Customer'}
                </button>
              ))}
            </div>
          </div>

          {/* GL Account — only for 'account' type; supplier/customer use AP/AR automatically */}
          {needsGlAccount && (
            <EntityPicker
              label="GL Account"
              placeholder="Select GL Account..."
              options={glAccounts}
              selected={selectedGl}
              onSelect={setSelectedGl}
            />
          )}

          {/* Supplier picker — only when allocType is supplier */}
          {allocType === 'supplier' && (
            <EntityPicker
              label="Supplier"
              placeholder="Select Supplier..."
              options={suppliers}
              selected={selectedSupplier}
              onSelect={setSelectedSupplier}
            />
          )}

          {/* Customer picker — only when allocType is customer */}
          {allocType === 'customer' && (
            <EntityPicker
              label="Customer"
              placeholder="Select Customer..."
              options={clients}
              selected={selectedClient}
              onSelect={setSelectedClient}
            />
          )}

          {/* VAT */}
          <div>
            <label className="text-xs text-[var(--ff-text-tertiary)] mb-1 block">VAT Treatment</label>
            <div className="flex gap-1">
              {VAT_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setVatCode(opt.value)}
                  className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                    vatCode === opt.value
                      ? 'bg-blue-600 text-white'
                      : 'bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] border border-[var(--ff-border-light)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Rule name */}
          <div>
            <label className="text-xs text-[var(--ff-text-tertiary)] mb-1 block">Rule Name</label>
            <input
              type="text"
              value={ruleName}
              onChange={e => setRuleName(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-primary)] focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Auto-create toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoCreateEntry}
              onChange={e => setAutoCreateEntry(e.target.checked)}
              className="accent-emerald-500"
            />
            <span className="text-xs text-[var(--ff-text-secondary)]">
              Auto-create journal entry (otherwise suggestion only)
            </span>
          </label>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--ff-border-light)]">
          <button onClick={onClose}
            className="px-4 py-1.5 rounded text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || !pattern.trim() || (needsGlAccount && !selectedGl)}
            className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium flex items-center gap-1.5">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create Rule
          </button>
        </div>
      </div>
    </div>
  );
}
