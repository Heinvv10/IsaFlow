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
  /** Sage account id (the account list's namespace) → the IsaFlow code it was given. */
  sageAccountCodes: Record<number, string>;
  /** Sage bank-account id → code, for banks the account list does not carry (their own namespace). */
  sageBankCodes: Record<number, string>;
  /** Sage account ids holding the receivable / payable roles. */
  controlIds: { receivable: number | null; payable: number | null };
}

/** A trial balance line's account: its code and the namespace it was found in. */
interface Resolved { ns: 'account' | 'bank'; code: string }

/** A Sage account and the id namespace it came from: the account list, or the bank list. */
interface Placed { a: SageAccount; ns: 'account' | 'bank' }

/**
 * Sage's accounts plus every bank account the account list does not carry.
 * A bank shows in both lists under one id (AccountType 3) and is the same
 * account; a bank whose id is taken in the account list by something that is
 * NOT a bank is a different account, kept in the bank namespace so neither
 * overwrites the other.
 */
function allSageAccounts(pull: SagePull): Placed[] {
  const byId = new Map(pull.accounts.map((a) => [a.ID, a]));
  const banks = pull.bankAccounts
    .filter((b) => byId.get(b.ID)?.AccountType !== 3)
    .map((b): Placed => ({ a: { ID: b.ID, Name: b.Name, Active: b.Active !== false, AccountType: 3, Balance: b.Balance }, ns: 'bank' }));
  return [...pull.accounts.map((a): Placed => ({ a, ns: 'account' })), ...banks];
}

/** Ids on the trial balance with a non-zero line. */
function tbIdsOf(pull: SagePull): Set<number> {
  return new Set(pull.trialBalance.filter((l) => Math.abs(l.Debit) > 0.005 || Math.abs(l.Credit) > 0.005).map((l) => l.AccountId));
}

export function buildAccounts(pull: SagePull, ctx: TakeOnContext, issues: TakeOnIssue[]): AccountsPart {
  const alloc = new CodeAllocator(ctx.takenCodes);
  const tbIds = tbIdsOf(pull);
  const sage = allSageAccounts(pull);
  const accounts: AccountImportRow[] = [];
  const codes: Record<number, string> = {};
  const bankCodes: Record<number, string> = {};
  const codeOf = (p: Placed) => (p.ns === 'bank' ? bankCodes : codes)[p.a.ID];
  const setCode = (p: Placed, code: string) => { (p.ns === 'bank' ? bankCodes : codes)[p.a.ID] = code; };
  const map: Partial<SystemAccountMap> = {};
  const controlIds = { receivable: null as number | null, payable: null as number | null };

  const firstBank = sage.filter(({ a }) => a.AccountType === 3 && (a.Active || tbIds.has(a.ID)))
    .sort((x, y) => x.a.Name.localeCompare(y.a.Name) || x.a.ID - y.a.ID)[0];
  const roleHolder = (role: SystemRole): Placed | undefined =>
    role === 'bank' ? firstBank : sage.find((p) => p.ns === 'account' && sageSystemRole(p.a.ID) === role);

  for (const role of ROLE_ORDER) {
    const holder = roleHolder(role);
    const existing = ctx.existingRoles[role];
    if (holder) {
      const c = classifySageAccount(holder.a);
      const type = existing?.type ?? (c.ok ? c.accountType : ROLE_DEFAULTS[role].type);
      const code = existing ? alloc.claim(existing.code) : alloc.next(type, role === 'bank' ? 'bank' : undefined);
      accounts.push({ accountCode: code, accountName: holder.a.Name, accountType: type, normalBalance: NORMAL[type] });
      setCode(holder, code);
      if (role === 'receivable' || role === 'payable') controlIds[role] = holder.a.ID;
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
    .filter((p) => codeOf(p) === undefined && (p.a.Active || tbIds.has(p.a.ID)))
    .map((p) => ({ p, a: p.a, c: classifySageAccount(p.a) }));
  rest.sort((x, y) => {
    const bx = x.c.ok ? bandBase(x.c.accountType, x.c.accountSubtype) : 9999;
    const by = y.c.ok ? bandBase(y.c.accountType, y.c.accountSubtype) : 9999;
    return bx - by || x.a.Name.localeCompare(y.a.Name) || x.a.ID - y.a.ID;
  });
  for (const { p, a, c } of rest) {
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
    setCode(p, code);
  }

  return { accounts, systemAccountMap: map as SystemAccountMap, sageAccountCodes: codes, sageBankCodes: bankCodes, controlIds };
}

export interface OpeningPart {
  openingBalances: OpeningBalanceRow[];
  openingBalanceClearing: { debit: number; credit: number };
  receivableControl: number;
  payableControl: number;
  trialBalanceDebit: number;
  trialBalanceCredit: number;
}

/**
 * Where a trial balance line posts: null when it has no account, undefined
 * when the line is ambiguous (already reported). An id in both namespaces is
 * told apart by the line's AccountTypeId (3 = bank); without one it is refused
 * rather than guessed.
 */
function codeForLine(l: SagePull['trialBalance'][number], part: AccountsPart, issues: TakeOnIssue[]): Resolved | null | undefined {
  const account = part.sageAccountCodes[l.AccountId];
  const bank = part.sageBankCodes[l.AccountId];
  if (account !== undefined && bank !== undefined) {
    if (l.AccountTypeId === 3) return { ns: 'bank', code: bank };
    if (l.AccountTypeId !== undefined) return { ns: 'account', code: account };
    issues.push({ severity: 'error', area: 'trial_balance', message: `Trial balance line "${l.Name}" could be the Sage account or the bank account with the same number (${l.AccountId}); IsaFlow cannot tell which. Ask IsaFlow support before importing.` });
    return undefined;
  }
  if (account !== undefined) return { ns: 'account', code: account };
  return bank !== undefined ? { ns: 'bank', code: bank } : null;
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
    const at = codeForLine(l, part, issues);
    if (at === undefined) continue;
    // The control holders are Sage system accounts: the ACCOUNT namespace only (R5).
    if (at?.ns === 'account' && l.AccountId === part.controlIds.receivable) { receivableControl += debit - credit; continue; }
    if (at?.ns === 'account' && l.AccountId === part.controlIds.payable) { payableControl += credit - debit; continue; }
    if (at === null) {
      // L1: only an ACCOUNT issue about this very account already explains the gap.
      if (!issues.some((i) => i.area === 'accounts' && i.message.includes(`"${l.Name}"`))) {
        issues.push({ severity: 'error', area: 'trial_balance', message: `Trial balance line "${l.Name}" has no account to post to.` });
      }
      continue;
    }
    lines.push({ accountCode: at.code, debit, credit });
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
