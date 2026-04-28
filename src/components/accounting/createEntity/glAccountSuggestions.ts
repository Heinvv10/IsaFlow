import type { SelectOption } from '../BankTxTable';

export interface GLSuggestion {
  code: string;
  name: string;
  type: string;
}

export const ACCOUNT_TYPES = [
  { value: 'expense', label: 'Expense', nb: 'debit' },
  { value: 'asset', label: 'Asset', nb: 'debit' },
  { value: 'liability', label: 'Liability', nb: 'credit' },
  { value: 'revenue', label: 'Revenue', nb: 'credit' },
  { value: 'equity', label: 'Equity', nb: 'credit' },
] as const;

const DESCRIPTION_SUGGESTIONS: { keywords: string[]; suggestion: GLSuggestion }[] = [
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
  { keywords: ['eft rec', 'payment received', 'deposit', 'receipt'],
    suggestion: { code: '4100', name: 'Service Revenue', type: 'revenue' } },
  { keywords: ['refund received', 'cashback'],
    suggestion: { code: '4300', name: 'Other Income', type: 'revenue' } },
];

const TYPE_CODE_RANGES: Record<string, { start: number; end: number; name: string }> = {
  asset:     { start: 1000, end: 1999, name: 'Other Asset' },
  liability: { start: 2000, end: 2999, name: 'Other Liability' },
  equity:    { start: 3000, end: 3999, name: 'Other Equity' },
  revenue:   { start: 4000, end: 4999, name: 'Other Revenue' },
  expense:   { start: 5000, end: 5999, name: 'Other Expense' },
};

export function suggestFromDescription(description?: string): GLSuggestion | null {
  if (!description) return null;
  const lower = description.toLowerCase();
  for (const entry of DESCRIPTION_SUGGESTIONS) {
    if (entry.keywords.some(kw => lower.includes(kw))) return entry.suggestion;
  }
  return null;
}

function pickFreeCode(taken: Set<number>, from: number, to: number, step = 1): number | null {
  for (let n = from; n <= to; n += step) {
    if (!taken.has(n)) return n;
  }
  return null;
}

/**
 * Pick a code for a new account that slots alphabetically into the existing
 * accounts of the same type. Always returns a code not already in use; falls
 * back to the next free code at the end of the range when no name is given,
 * no peers exist, or the alphabetic neighbours leave no free slot.
 */
export function suggestCodeForName(
  accountType: string,
  accountName: string,
  existing: SelectOption[] = []
): string {
  const range = TYPE_CODE_RANGES[accountType] ?? TYPE_CODE_RANGES.expense!;
  const peers = existing
    .filter(a => {
      const n = Number(a.code);
      return Number.isFinite(n) && n >= range.start && n <= range.end;
    })
    .map(a => ({ code: Number(a.code), name: (a.name || '').trim() }))
    .sort((x, y) => x.code - y.code);

  const taken = new Set(peers.map(p => p.code));
  const trimmedName = accountName.trim();

  const findFree = (lo: number, hi: number): string | null => {
    const tens = pickFreeCode(taken, Math.ceil(lo / 10) * 10, hi, 10);
    if (tens !== null) return String(tens);
    const any = pickFreeCode(taken, lo, hi, 1);
    return any !== null ? String(any) : null;
  };

  if (!trimmedName || peers.length === 0) {
    const lo = peers.length ? peers[peers.length - 1]!.code + 1 : range.start;
    return findFree(lo, range.end) ?? findFree(range.start, range.end) ?? String(range.end);
  }

  const lower = trimmedName.toLowerCase();
  for (let i = 0; i < peers.length; i++) {
    if (peers[i]!.name.toLowerCase() > lower) {
      const before = i === 0 ? range.start - 1 : peers[i - 1]!.code;
      const after = peers[i]!.code;
      if (after - before > 1) {
        const slot = findFree(before + 1, after - 1);
        if (slot !== null) return slot;
      }
      return findFree(after + 1, range.end) ?? findFree(range.start, range.end) ?? String(range.end);
    }
  }
  const lo = peers[peers.length - 1]!.code + 1;
  return findFree(lo, range.end) ?? findFree(range.start, range.end) ?? String(range.end);
}

export function suggestFromType(
  accountType: string,
  accountName?: string,
  existing?: SelectOption[]
): GLSuggestion {
  const range = TYPE_CODE_RANGES[accountType] ?? TYPE_CODE_RANGES.expense!;
  const name = (accountName ?? '').trim() || range.name;
  const code = suggestCodeForName(accountType, accountName ?? '', existing);
  return { code, name, type: accountType };
}
