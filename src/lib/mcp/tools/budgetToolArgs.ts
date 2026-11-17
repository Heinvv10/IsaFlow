/**
 * What the MCP budget tools share: money as decimal TEXT in and out (never a float on the wire), months,
 * the version-ownership check (the shared NOT_FOUND for another company's id and a genuine miss alike),
 * the owner gate for the four human-gated moves, and the scopes. Budget figures are report data (P5-2 S1):
 * every budget tool, read or write, needs read:reports, checked by the registry before the handler (a write
 * scope alone would let dry runs answer figures: an add overflow, an unchanged cell, a replace's clears).
 */
import Decimal from 'decimal.js';
import { UUID_RE } from '@/lib/validation';
import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { BudgetVersionError, type BudgetVersion } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { isVersionToken } from '@/modules/accounting/services/budgets/gridErrors';
import { MAX_CENTS, ROUNDING_UNITS, type RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import type { McpToolContext, McpToolResult } from '../types';
import { NOT_FOUND, toolError } from './toolHelpers';

/** Hein's ruling 2 (2026-11-16): an agent approves, locks, unlocks or sets primary only on an owner's token. */
export const PERSON_MUST_APPROVE = 'A person must approve this budget in IsaFlow';

export const BUDGET_WRITE_SCOPE = 'write:budgets';
export const BUDGET_READ_SCOPE = 'read:reports';

/** Every budget WRITE tool: write:budgets, and read:reports as well (the registry refuses either missing). */
export const BUDGET_WRITE_FENCE = { scope: BUDGET_WRITE_SCOPE, requiresScope: BUDGET_READ_SCOPE } as const;

const MONEY = /^-?\d{1,13}(\.\d{1,2})?$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A decimal string ("1250", "-30.5", "0.75") as integer cents, or the reason it is refused. */
export function parseMoney(value: unknown): { cents: number } | { error: string } {
  if (typeof value !== 'string') return { error: 'amounts are decimal strings such as "1250.00" (numbers are refused: no floats)' };
  const text = value.trim();
  if (!MONEY.test(text)) {
    return { error: /^-?\d+\.\d{3,}$/.test(text) ? 'an amount has at most 2 decimals' : `${JSON.stringify(text.slice(0, 24))} is not a decimal amount such as "1250.00"` };
  }
  const cents = new Decimal(text).times(100).toNumber();
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CENTS) return { error: 'the amount is larger than a budget month can hold (9 999 999 999 999.99)' };
  return { cents: cents === 0 ? 0 : cents };
}

/** Integer cents as decimal text ("-1234.50"), exact. */
export function centsText(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A rand amount the services hold as a number (NUMERIC(15,2) read exactly) as decimal text. */
export const randText = (rand: number): string => centsText(Math.round(rand * 100));

/**
 * An account, member or cost-centre reference (an id or a code) as the budget tools read it (review round 3, one rule
 * for every tool): a string trimmed; a finite integer as its digits (a numeric code sent as a JSON number); any other
 * number refused as "not a <what> code" (never truncated); anything else '' (absent, for the caller's own wording).
 */
export function refText(v: unknown, what = 'account'): { ref: string } | { error: string } {
  if (typeof v === 'string') return { ref: v.trim() };
  if (typeof v === 'number') return Number.isInteger(v) ? { ref: String(v) } : { error: `${String(v)} is not ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what} code` };
  return { ref: '' };
}

export const isMonth = (v: unknown): v is string => typeof v === 'string' && MONTH.test(v);

export function roundingUnitArg(args: Record<string, unknown>): RoundingUnit | McpToolResult {
  const raw = args.rounding_unit ?? 1;
  return (ROUNDING_UNITS as readonly unknown[]).includes(raw) ? raw as RoundingUnit : toolError('rounding_unit must be 1, 100 or 1000');
}

/** The plan_hash a dry run answered (64 hex), absent, or a refusal for a malformed one. */
export function planHashArg(args: Record<string, unknown>): string | null | McpToolResult {
  const raw = args.plan_hash;
  if (raw === undefined || raw === null) return null;
  return typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw) ? raw : toolError('plan_hash must be the plan_hash your dry run returned');
}

export const PLAN_CHANGED = 'The plan changed since your dry run (the budget, or the request, is not what the dry run saw); nothing was written. Dry-run again and apply with the new plan_hash.';

/** The optional version_token (the dry run's `version_token`), or a refusal for a malformed one. */
export function versionTokenArg(args: Record<string, unknown>): string | null | McpToolResult {
  const raw = args.version_token;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.length > 40 || !isVersionToken(raw)) return toolError('version_token must be the version_token a dry run or read returned');
  return raw;
}

/** A version id argument: the company's own version, or the shared NOT_FOUND (another company's id included). */
export async function ownVersion(ctx: McpToolContext, value: unknown, arg = 'version_id'): Promise<BudgetVersion | McpToolResult> {
  if (typeof value !== 'string' || !UUID_RE.test(value)) return toolError(`invalid ${arg}`);
  try {
    return await getVersion(ctx.companyId, value.toLowerCase());
  } catch (err) {
    if (err instanceof BudgetVersionError && err.code === 'BUDGET_VERSION_NOT_FOUND') return toolError(NOT_FOUND);
    throw err;
  }
}

export const isResult = (v: unknown): v is McpToolResult => typeof v === 'object' && v !== null && 'content' in v && Array.isArray((v as McpToolResult).content);

/** Ruling 2: checked from the token user's role BEFORE any service is called. */
export const ownerGate = (ctx: McpToolContext): McpToolResult | null => (ctx.companyRole === 'owner' ? null : toolError(PERSON_MUST_APPROVE));

/** A version as the tools answer it: totals as decimal text (`total`: the sum of every amount cell of the version). */
export function versionView(v: BudgetVersion) {
  return {
    id: v.id, fiscal_year: v.fiscalYear, name: v.name, kind: v.kind, status: v.status, is_primary: v.isPrimary,
    based_on_version_id: v.basedOnVersionId, version_token: v.updatedAt, cells: v.amountCount, total: randText(v.total),
    approved_by: v.approvedBy, approved_at: v.approvedAt, locked_by: v.lockedBy, locked_at: v.lockedAt,
    unlocked_by: v.unlockedBy, unlocked_at: v.unlockedAt, unlock_reason: v.unlockReason, created_by: v.createdBy, created_at: v.createdAt,
  };
}
