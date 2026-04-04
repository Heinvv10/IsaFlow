/**
 * Reusable form section panels for the New Item page.
 */

interface Category {
  id: string;
  name: string;
}

interface Account {
  id: string;
  account_number: string;
  name: string;
}

const VAT_OPTIONS = [
  { value: 'standard', label: 'Standard (15%)' },
  { value: 'zero', label: 'Zero Rated (0%)' },
  { value: 'exempt', label: 'Exempt' },
];

// ── ItemDetailsSection ────────────────────────────────────────────────────────

interface DetailsProps {
  code: string;
  description: string;
  category_id: string;
  item_type: 'physical' | 'service';
  unit: string;
  is_active: boolean;
  categories: Category[];
  onChange: (field: string, value: string | boolean) => void;
}

export function ItemDetailsSection({ code, description, category_id, item_type, unit, is_active, categories, onChange }: DetailsProps) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
      <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Item Details</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
            Code <span className="text-[var(--ff-text-tertiary)]">(auto-generated if blank)</span>
          </label>
          <input type="text" value={code} onChange={e => onChange('code', e.target.value)} className="ff-input w-full" placeholder="ITEM-0001" />
        </div>
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Description *</label>
          <input type="text" required value={description} onChange={e => onChange('description', e.target.value)} className="ff-input w-full" />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Category</label>
          <select value={category_id} onChange={e => onChange('category_id', e.target.value)} className="ff-select w-full">
            <option value="">No category</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Item Type *</label>
          <div className="flex gap-4 mt-2">
            {(['physical', 'service'] as const).map(t => (
              <label key={t} className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)] cursor-pointer">
                <input type="radio" name="item_type" value={t} checked={item_type === t} onChange={e => onChange('item_type', e.target.value)} className="accent-teal-500" />
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Unit</label>
          <input type="text" value={unit} onChange={e => onChange('unit', e.target.value)} className="ff-input w-full" placeholder="each" />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)] cursor-pointer">
        <input type="checkbox" checked={is_active} onChange={e => onChange('is_active', e.target.checked)} className="accent-teal-500 h-4 w-4" />
        Active
      </label>
    </div>
  );
}

// ── PricingSection ────────────────────────────────────────────────────────────

interface PricingProps {
  cost_price: string;
  selling_price_excl: string;
  selling_price_incl: string;
  gp_percent: string;
  onChange: (field: string, value: string) => void;
}

export function PricingSection({ cost_price, selling_price_excl, selling_price_incl, gp_percent, onChange }: PricingProps) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
      <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Pricing</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Cost Price (ZAR)</label>
          <input type="number" step="0.01" min="0" value={cost_price} onChange={e => onChange('cost_price', e.target.value)} className="ff-input w-full" />
        </div>
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Exclusive Selling Price (ZAR)</label>
          <input type="number" step="0.01" min="0" value={selling_price_excl} onChange={e => onChange('selling_price_excl', e.target.value)} className="ff-input w-full" />
        </div>
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Inclusive Selling Price (ZAR)</label>
          <input type="number" step="0.01" min="0" value={selling_price_incl} onChange={e => onChange('selling_price_incl', e.target.value)} className="ff-input w-full" />
        </div>
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">GP %</label>
          <input type="number" step="0.01" value={gp_percent} onChange={e => onChange('gp_percent', e.target.value)} className="ff-input w-full" readOnly />
        </div>
      </div>
    </div>
  );
}

// ── VatAccountsSection ────────────────────────────────────────────────────────

interface VatAccountsProps {
  vat_on_sales: string;
  vat_on_purchases: string;
  sales_account_id: string;
  purchases_account_id: string;
  salesAccounts: Account[];
  purchaseAccounts: Account[];
  onChange: (field: string, value: string) => void;
}

export function VatAccountsSection({ vat_on_sales, vat_on_purchases, sales_account_id, purchases_account_id, salesAccounts, purchaseAccounts, onChange }: VatAccountsProps) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
      <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">VAT & Accounts</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">VAT on Sales</label>
          <select value={vat_on_sales} onChange={e => onChange('vat_on_sales', e.target.value)} className="ff-select w-full">
            {VAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">VAT on Purchases</label>
          <select value={vat_on_purchases} onChange={e => onChange('vat_on_purchases', e.target.value)} className="ff-select w-full">
            {VAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Sales Account</label>
          <select value={sales_account_id} onChange={e => onChange('sales_account_id', e.target.value)} className="ff-select w-full">
            <option value="">Select account...</option>
            {salesAccounts.map(a => <option key={a.id} value={a.id}>{a.account_number} - {a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Purchases Account</label>
          <select value={purchases_account_id} onChange={e => onChange('purchases_account_id', e.target.value)} className="ff-select w-full">
            <option value="">Select account...</option>
            {purchaseAccounts.map(a => <option key={a.id} value={a.id}>{a.account_number} - {a.name}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}

// ── OpeningBalancesSection ────────────────────────────────────────────────────

interface OpeningProps {
  opening_qty: string;
  opening_cost: string;
  opening_date: string;
  onChange: (field: string, value: string) => void;
}

export function OpeningBalancesSection({ opening_qty, opening_cost, opening_date, onChange }: OpeningProps) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
      <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Opening Balances</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Opening Qty</label>
          <input type="number" step="1" min="0" value={opening_qty} onChange={e => onChange('opening_qty', e.target.value)} className="ff-input w-full" />
        </div>
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Opening Cost (ZAR)</label>
          <input type="number" step="0.01" min="0" value={opening_cost} onChange={e => onChange('opening_cost', e.target.value)} className="ff-input w-full" />
        </div>
        <div>
          <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Opening Date</label>
          <input type="date" value={opening_date} onChange={e => onChange('opening_date', e.target.value)} className="ff-input w-full" />
        </div>
      </div>
    </div>
  );
}
