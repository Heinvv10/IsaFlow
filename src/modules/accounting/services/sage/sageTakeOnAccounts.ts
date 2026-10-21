/**
 * Sage chart of accounts and trial balance → the COA and opening-balance rows
 * of the migration take-on.
 *
 * Sage SA accounts have no codes, so codes are allocated per band (bank 1010…,
 * current assets 1210…, …, expenses 6010…) skipping every code the company
 * already uses and the codes reserved for Opening Balance Equity. A Sage
 * account that holds a role (Trade Receivables, VAT Payable, …) lands on the
 * company's existing holder of that role, so the chart gets no duplicate
 * control accounts.
 */
import type { GLAccountType } from '@/modules/accounting/types/gl.types';
import { canonicalSubtype } from '../gl/accountSubtypes';
import type { AccountImportRow, SystemAccountMap } from '../core/migrationCoaService';
import type { OpeningBalanceRow } from '../core/migrationWizardOpeningBalanceService';
import { classifySageAccount, sageSystemRole } from './sageAccountClassifier';
import type { SageAccount, SagePull } from './sageApiTypes';
import { round2, type SystemRole, type TakeOnContext, type TakeOnIssue } from './sageTakeOnTypes';

const OBE_RESERVED_CODES = ['3300', '3310', '3320', '3390'];

const ROLE_ORDER: readonly SystemRole[] = [
  'bank', 'receivable', 'payable', 'vat_input', 'vat_output', 'retained_earnings',
  'default_revenue', 'default_expense', 'admin_expense',
];

const ROLE_DEFAULTS: Record<SystemRole, { name: string; type: GLAccountType }> = {
  bank: { name: 'Bank', type: 'asset' },
  receivable: { name: 'Trade Receivables', type: 'asset' },
  payable: { name: 'Trade Payables', type: 'liability' },
  vat_input: { name: 'VAT Input', type: 'asset' },
  vat_output: { name: 'VAT Output', type: 'liability' },
  retained_earnings: { name: 'Retained Earnings', type: 'equity' },
  default_revenue: { name: 'Sales', type: 'revenue' },
  default_expense: { name: 'Cost of Sales', type: 'expense' },
  admin_expense: { name: 'Administrative Expenses', type: 'expense' },
};

const NORMAL: Record<GLAccountType, 'debit' | 'credit'> = {
  asset: 'debit', expense: 'debit', liability: 'credit', equity: 'credit', revenue: 'credit',
};

function bandBase(type: GLAccountType, subtype: string | undefined): number {
  // Through the shared vocabulary (gl/accountSubtypes), so a band reads the
  // same concept every report reads; 'other' is the classifier's own marker.
  const canon = canonicalSubtype(subtype);
  const other = subtype === 'other';
  switch (type) {
    case 'asset':
      if (canon === 'bank') return 1010;
      if (canon === 'cash') return 1050;
      if (canon === 'fixed_asset' || other) return 1510;
      return 1210;
    case 'liability': return canon === 'long_term_liability' ? 2510 : 2310;
    case 'equity': return 3110;
    case 'revenue': return other ? 4110 : 4010;
    case 'expense':
      if (canon === 'cost_of_sales') return 5010;
      if (other) return 6910;
      return 6010;
  }
}

class CodeAllocator {
  private readonly used: Set<string>;
  constructor(taken: readonly string[]) { this.used = new Set([...taken, ...OBE_RESERVED_CODES]); }
  claim(code: string): string { this.used.add(code); return code; }
  next(type: GLAccountType, subtype: string | undefined): string {
    let n = bandBase(type, subtype);
    while (this.used.has(String(n))) n++;
    return this.claim(String(n));
  }
}

export interface AccountsPart {
  accounts: AccountImportRow[];
  systemAccountMap: SystemAccountMap;
  sageAccountCodes: Record<number, string>;
  /** Sage account ids holding the receivable / payable roles. */
  controlIds: { receivable: number | null; payable: number | null };
}

/** Sage's accounts plus any bank account the account list left out. */
function allSageAccounts(pull: SagePull): SageAccount[] {
  const ids = new Set(pull.accounts.map((a) => a.ID));
  const banks = pull.bankAccounts
    .filter((b) => !ids.has(b.ID))
    .map((b): SageAccount => ({ ID: b.ID, Name: b.Name, Active: b.Active !== false, AccountType: 3, Balance: b.Balance }));
  return [...pull.accounts, ...banks];
}

export function buildAccounts(pull: SagePull, ctx: TakeOnContext, issues: TakeOnIssue[]): AccountsPart {
  const alloc = new CodeAllocator(ctx.takenCodes);
  const tbIds = new Set(pull.trialBalance.filter((l) => Math.abs(l.Debit) > 0.005 || Math.abs(l.Credit) > 0.005).map((l) => l.AccountId));
  const sage = allSageAccounts(pull);
  const accounts: AccountImportRow[] = [];
  const codes: Record<number, string> = {};
  const map: Partial<SystemAccountMap> = {};
  const controlIds = { receivable: null as number | null, payable: null as number | null };

  const firstBank = [...sage].filter((a) => a.AccountType === 3 && (a.Active || tbIds.has(a.ID)))
    .sort((a, b) => a.Name.localeCompare(b.Name) || a.ID - b.ID)[0];
  const roleHolder = (role: SystemRole): SageAccount | undefined =>
    role === 'bank' ? firstBank : sage.find((a) => sageSystemRole(a.ID) === role);

  for (const role of ROLE_ORDER) {
    const holder = roleHolder(role);
    const existing = ctx.existingRoles[role];
    if (holder) {
      const c = classifySageAccount(holder);
      const type = existing?.type ?? (c.ok ? c.accountType : ROLE_DEFAULTS[role].type);
      const code = existing ? alloc.claim(existing.code) : alloc.next(type, role === 'bank' ? 'bank' : undefined);
      accounts.push({ accountCode: code, accountName: holder.Name, accountType: type, normalBalance: NORMAL[type] });
      codes[holder.ID] = code;
      if (role === 'receivable' || role === 'payable') controlIds[role] = holder.ID;
      map[role] = code;
    } else if (existing) {
      accounts.push({ accountCode: alloc.claim(existing.code), accountName: existing.name, accountType: existing.type, normalBalance: NORMAL[existing.type] });
      map[role] = existing.code;
    } else {
      const d = ROLE_DEFAULTS[role];
      const code = alloc.next(d.type, role === 'bank' ? 'bank' : undefined);
      accounts.push({ accountCode: code, accountName: d.name, accountType: d.type, normalBalance: NORMAL[d.type] });
      map[role] = code;
    }
  }

  const rest = sage
    .filter((a) => codes[a.ID] === undefined && (a.Active || tbIds.has(a.ID)))
    .map((a) => ({ a, c: classifySageAccount(a) }));
  rest.sort((x, y) => {
    const bx = x.c.ok ? bandBase(x.c.accountType, x.c.accountSubtype) : 9999;
    const by = y.c.ok ? bandBase(y.c.accountType, y.c.accountSubtype) : 9999;
    return bx - by || x.a.Name.localeCompare(y.a.Name) || x.a.ID - y.a.ID;
  });
  for (const { a, c } of rest) {
    if (!c.ok) {
      issues.push({
        severity: tbIds.has(a.ID) ? 'error' : 'warning',
        area: 'accounts',
        message: tbIds.has(a.ID)
          ? `Sage account "${a.Name}" has a balance but cannot be placed: ${c.reason}. Change its category in Sage and pull again.`
          : `Sage account "${a.Name}" was left out: ${c.reason}. It has no balance.`,
      });
      continue;
    }
    const code = alloc.next(c.accountType, c.accountSubtype);
    accounts.push({ accountCode: code, accountName: a.Name, accountType: c.accountType, accountSubtype: c.accountSubtype, normalBalance: c.normalBalance });
    codes[a.ID] = code;
  }

  return { accounts, systemAccountMap: map as SystemAccountMap, sageAccountCodes: codes, controlIds };
}

export interface OpeningPart {
  openingBalances: OpeningBalanceRow[];
  openingBalanceClearing: { debit: number; credit: number };
  receivableControl: number;
  payableControl: number;
  trialBalanceDebit: number;
  trialBalanceCredit: number;
}

export function buildOpeningBalances(pull: SagePull, part: AccountsPart, issues: TakeOnIssue[]): OpeningPart {
  const lines: OpeningBalanceRow[] = [];
  let receivableControl = 0;
  let payableControl = 0;
  let tbDr = 0;
  let tbCr = 0;
  for (const l of pull.trialBalance) {
    const debit = round2(l.Debit || 0);
    const credit = round2(l.Credit || 0);
    tbDr += debit;
    tbCr += credit;
    if (debit === 0 && credit === 0) continue;
    if (l.AccountId === part.controlIds.receivable) { receivableControl += debit - credit; continue; }
    if (l.AccountId === part.controlIds.payable) { payableControl += credit - debit; continue; }
    const code = part.sageAccountCodes[l.AccountId];
    if (!code) {
      if (!issues.some((i) => i.message.includes(`"${l.Name}"`))) {
        issues.push({ severity: 'error', area: 'trial_balance', message: `Trial balance line "${l.Name}" has no account to post to.` });
      }
      continue;
    }
    lines.push({ accountCode: code, debit, credit });
  }
  tbDr = round2(tbDr);
  tbCr = round2(tbCr);
  if (Math.abs(tbDr - tbCr) > 0.01) {
    issues.push({ severity: 'error', area: 'trial_balance', message: `Sage's trial balance does not balance (debits ${tbDr.toFixed(2)}, credits ${tbCr.toFixed(2)}). Check it in Sage before importing.` });
  }
  const gap = round2(round2(receivableControl) - round2(payableControl));
  return {
    openingBalances: lines,
    openingBalanceClearing: gap >= 0 ? { debit: gap, credit: 0 } : { debit: 0, credit: -gap },
    receivableControl: round2(receivableControl),
    payableControl: round2(payableControl),
    trialBalanceDebit: tbDr,
    trialBalanceCredit: tbCr,
  };
}
