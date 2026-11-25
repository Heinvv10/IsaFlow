/**
 * Which recorded values are masked (Hein's decision 2, 2026-10-10): bank
 * account numbers and ID / tax numbers are stored in full and shown as their
 * last four characters to everyone; owner / admin may reveal one change in
 * full (entityChangeReveal.ts, audited). A changed value stays visibly
 * changed: …1234 → …9876. An employee's bank details also mask the branch
 * code (last two) and the holder (first letter), as their GET does for a
 * non-admin. That reduces, not prevents, matching employees to one account:
 * the last two digits with the bank name often give a bank's universal branch
 * code, and the last four, bank, account type and initial can still match.
 */
import type { EntityChangeField, EntityType } from './entityChangeTypes';

export const SENSITIVE_FIELDS: Readonly<Record<EntityType, readonly string[]>> = {
  supplier: ['bank_account_number'],
  customer: [],
  gl_account: ['bank_account_number'],
  payroll_employee: ['id_number', 'passport_number', 'tax_number', 'tax_directive_number', 'uif_number'],
  company_user: [],
  company_invitation: [],
  company_user_permission: [],
  company: ['bank_account_number', 'tax_number', 'paye_reference_number', 'sdl_reference_number', 'uif_reference_number'],
  approval_rule: [],
  approval_enforcement: [],
  payroll_bank_detail: ['account_number', 'branch_code', 'account_holder'],
  company_setting: [],
  supplier_invoice: [],
  customer_invoice: [],
};

export const isSensitive = (type: EntityType, key: string): boolean => SENSITIVE_FIELDS[type].includes(key);

/** The last four characters behind an ellipsis; four or fewer are hidden entirely. */
export function maskValue(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return value;
  const text = String(value).trim();
  if (text.length <= 4) return '••••';
  return `…${text.slice(-4)}`;
}

/** The last two characters behind an ellipsis (a branch code); two or fewer are hidden entirely. */
export function maskLastTwo(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return value;
  const text = String(value).trim();
  if (text.length <= 2) return '••';
  return `…${text.slice(-2)}`;
}

/** The first letter and an ellipsis (a name); two characters or fewer are hidden entirely. */
export function maskInitial(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return value;
  const chars = Array.from(String(value).trim());
  if (chars.length <= 2) return '••';
  return `${chars[0]}…`;
}

/** Fields masked other than to their last four. */
const FIELD_MASKS: Partial<Record<EntityType, Readonly<Record<string, (value: unknown) => unknown>>>> = {
  payroll_bank_detail: { branch_code: maskLastTwo, account_holder: maskInitial },
};

const maskField = (type: EntityType, key: string, value: unknown): unknown => (FIELD_MASKS[type]?.[key] ?? maskValue)(value);

/** The changed fields of one change, masked unless `reveal`. Keys sorted as recorded. */
export function changeFields(
  type: EntityType,
  changed: readonly string[],
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  reveal = false,
): EntityChangeField[] {
  return changed.map((key) => {
    const masked = !reveal && isSensitive(type, key);
    const b = before ? (before[key] ?? null) : null;
    const a = after ? (after[key] ?? null) : null;
    return { key, before: masked ? maskField(type, key, b) : b, after: masked ? maskField(type, key, a) : a, masked };
  });
}
